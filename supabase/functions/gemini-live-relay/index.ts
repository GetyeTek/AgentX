import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 Phone Connected ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let lastImageBase64: string | null = null;

    // 1. FORWARD & INTERCEPT: Phone -> Gemini
    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState !== WebSocket.OPEN) return;

      try {
        const data = JSON.parse(event.data);

        // INTERCEPT: If it's a streaming image, buffer it instead of sending
        if (data.realtime_input?.media_chunks) {
          const imageChunk = data.realtime_input.media_chunks.find((c: any) => c.mime_type === "image/jpeg");
          if (imageChunk) {
            lastImageBase64 = imageChunk.data;
            // console.log("--- [RELAY] 📸 Buffered Image Chunk ---");
            
            // If there's ONLY an image in this message, stop here (don't forward to Google)
            if (data.realtime_input.media_chunks.length === 1) return;
            
            // If there's other stuff (like audio), remove the image and forward the rest
            data.realtime_input.media_chunks = data.realtime_input.media_chunks.filter((c: any) => c.mime_type !== "image/jpeg");
          }
        }

        // INJECT: If it's a client turn (the nudge), attach the buffered image inline
        if (data.client_content?.turns && lastImageBase64) {
          console.log("--- [RELAY] 📎 Injecting Image Inline into Turn ---");
          const firstTurn = data.client_content.turns[0];
          if (firstTurn && firstTurn.parts) {
            // Add image as the first part of the turn
            firstTurn.parts.unshift({
              inline_data: { mime_type: "image/jpeg", data: lastImageBase64 }
            });
            lastImageBase64 = null; // Clear buffer
          }
        }

        googleSocket.send(JSON.stringify(data));
      } catch {
        // Fallback for binary data (Audio PCM) or non-JSON
        googleSocket.send(event.data);
      }
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Connected. Sending Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: {
            parts: [{ text: "You are a helpful AI assistant named AgentX. Analyze the image provided in the user's turn and respond naturally." }]
          },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    // 2. FORWARD: Gemini -> Phone
    googleSocket.onmessage = async (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        clientSocket.send(event.data);
      } else {
        try {
          const data = JSON.parse(event.data);
          const content = data.server_content || data.serverContent;
          if (content) {
            const transcript = content.output_transcription?.text || content.outputTranscription?.text;
            if (transcript) console.log("--- [AI] 💬:", transcript);
          }
          clientSocket.send(event.data);
        } catch {
          clientSocket.send(event.data);
        }
      }
    };

    googleSocket.onclose = () => clientSocket.close();
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});