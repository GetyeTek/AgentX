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

    // 1. FORWARD: Phone -> Gemini
    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        // Forward raw text (JSON) or binary (Audio) from Android app to Google
        googleSocket.send(event.data);
      }
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Connected. Sending Setup... ---");
      // MAINTAINING YOUR EXACT JSON CONFIGURATION
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: {
            parts: [{ text: "You are a helpful AI assistant. You will receive 3 images and some audio. Describe the content of the images in detail and respond to the audio." }]
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
        // Forward raw binary audio from Gemini to Phone
        clientSocket.send(event.data);
      } else {
        // Process JSON for logging, then forward to Phone
        try {
          const data = JSON.parse(event.data);
          const content = data.server_content || data.serverContent;
          if (content) {
            const parts = content.model_turn?.parts || content.modelTurn?.parts;
            if (parts) parts.forEach(p => { if (p.text) console.log("--- [AI TEXT] 🧠:", p.text); });
            
            const transcript = content.output_transcription?.text || content.outputTranscription?.text;
            if (transcript) console.log("--- [AI TRANSCRIPT] 💬:", transcript);
          }
          clientSocket.send(event.data);
        } catch {
          clientSocket.send(event.data);
        }
      }
    };

    googleSocket.onerror = (e) => console.error("--- [GOOGLE ERROR] ---", e);
    googleSocket.onclose = () => {
      console.log("--- [GOOGLE CLOSED] ---");
      clientSocket.close();
    };

    clientSocket.onclose = () => {
      console.log("--- [PHONE DISCONNECTED] ---");
      googleSocket.close();
    };
  };

  return response;
});