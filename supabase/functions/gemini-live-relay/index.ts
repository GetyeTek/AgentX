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

    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(event.data);
      }
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Connected. Sending Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            // SWITCHING TO TEXT ONLY
            response_modalities: ["TEXT"],
          },
          system_instruction: {
            parts: [{ text: "You are AgentX, a text-based vision assistant. Describe what you see in the provided images concisely. Respond only with text. Do not attempt to generate audio." }]
          },
          // Keep transcriptions enabled just in case the model uses them for internal state
          input_audio_transcription: {},
          output_audio_transcription: {},
          context_window_compression: {
            sliding_window: { target_tokens: 15000 }
          }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        // Even in TEXT mode, we relay binary just in case, but it shouldn't trigger
        clientSocket.send(event.data);
      } else {
        try {
          const data = JSON.parse(event.data);
          
          // --- DETAILED RAW LOGGING ---
          console.log("--- [RAW GOOGLE RESPONSE] ---");
          console.log(JSON.stringify(data, null, 2));
          console.log("------------------------------");

          const content = data.server_content || data.serverContent;
          if (content) {
            const parts = content.model_turn?.parts || content.modelTurn?.parts;
            if (parts) {
              parts.forEach((p: any) => {
                if (p.text) console.log("--- [FOUND TEXT] 🧠:", p.text);
              });
            }
          }
          
          clientSocket.send(event.data);
        } catch (e) {
          console.error("--- [PARSE ERROR] ---", e);
          clientSocket.send(event.data);
        }
      }
    };

    googleSocket.onclose = (e) => console.log("--- [GOOGLE CLOSED] ---", e.code);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});