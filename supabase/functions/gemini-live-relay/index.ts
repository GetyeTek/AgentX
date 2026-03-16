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
            // MANDATORY for Bidi endpoint to avoid 1007 error
            response_modalities: ["AUDIO"],
            speech_config: { 
                voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } 
            }
          },
          system_instruction: {
            parts: [{ text: "You are AgentX. Analyze screenshots provided inline. Provide very short, concise text responses. Your text will be read via transcriptions." }]
          },
          // These allow us to see the text in the logs and on the HUD
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
        // Relaying audio chunks (Android app can ignore these)
        clientSocket.send(event.data);
      } else {
        try {
          const data = JSON.parse(event.data);
          
          // Verbose logging to catch exactly what Gemini is sending
          if (!data.setup_complete && !data.setupComplete) {
            console.log("--- [RAW GOOGLE RESPONSE] ---");
            console.log(JSON.stringify(data, null, 2));
          }

          const content = data.server_content || data.serverContent;
          if (content) {
            // Check for transcription text (this is our primary 'text' output)
            const transcript = content.output_transcription?.text || content.outputTranscription?.text;
            if (transcript) console.log("--- [TRANSCRIPT] 💬:", transcript);
            
            // Check for model_turn text (sometimes populated alongside audio)
            const parts = content.model_turn?.parts || content.modelTurn?.parts;
            if (parts) {
              parts.forEach((p: any) => {
                if (p.text) console.log("--- [MODEL TEXT] 🧠:", p.text);
              });
            }
          }
          
          clientSocket.send(event.data);
        } catch (e) {
          clientSocket.send(event.data);
        }
      }
    };

    googleSocket.onclose = (e) => console.log("--- [GOOGLE CLOSED] ---", e.code);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});