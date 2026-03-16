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

    // Transparent Forward: Phone -> Gemini
    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(event.data);
      }
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Connected ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: {
            parts: [{ text: "You are AgentX, a real-time AI assistant with vision. You will receive frequent screenshots via inline_data in user turns. Analyze the screen and provide helpful, concise context. If the screen hasn't changed significantly, keep your responses very brief or silent. Always respond to audio inputs immediately." }]
          },
          input_audio_transcription: {},
          output_audio_transcription: {},
          context_window_compression: {
            sliding_window: {
              target_tokens: 15000
            }
          }
        }
      }));
    };

    // Transparent Forward: Gemini -> Phone
    googleSocket.onmessage = async (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      if (!(event.data instanceof Blob || event.data instanceof ArrayBuffer)) {
        try {
          const data = JSON.parse(event.data);
          const content = data.server_content || data.serverContent;
          const transcript = content?.output_transcription?.text || content?.outputTranscription?.text;
          if (transcript) console.log("--- [AI] 💬:", transcript);
        } catch (e) {}
      }
      clientSocket.send(event.data);
    };

    googleSocket.onclose = () => clientSocket.close();
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});