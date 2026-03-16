import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let transcriptionBuffer = ""; // Buffer to hold text until backticks close

    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.send(event.data);
    };

    googleSocket.onopen = () => {
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: {
            parts: [{
              text: "You are AgentX. IMPORTANT: You must wrap every single sentence or coherent thought in triple backticks. Example: ```I see your screen.``` or ```You are clicking the start button.``` Only one sentence per block. Do not speak outside of backticks."
            }]
          },
          output_audio_transcription: {},
          context_window_compression: { sliding_window: { target_tokens: 15000 } }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      // 1. Always forward binary audio immediately for zero-lag voice
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        clientSocket.send(event.data);
        return;
      }

      try {
        const data = JSON.parse(event.data);
        const content = data.server_content || data.serverContent;
        
        if (content) {
          const transcript = content.output_transcription?.text || content.outputTranscription?.text;
          
          if (transcript) {
            transcriptionBuffer += transcript;

            // Check if we have a closed block: ``` text ```
            if (transcriptionBuffer.includes("```")) {
              const parts = transcriptionBuffer.split("```");
              
              // We need at least 3 parts for a full block (empty/before, content, after)
              if (parts.length >= 3) {
                const coherentBlock = parts[1].trim();
                
                if (coherentBlock.length > 0) {
                  console.log("--- [RELAY] 📦 Sending Coherent Block:", coherentBlock);
                  
                  // Send a synthetic Model Turn to the phone
                  clientSocket.send(JSON.stringify({
                    server_content: {
                      model_turn: {
                        parts: [{ text: coherentBlock }]
                      }
                    }
                  }));
                }
                
                // Remove the processed block from buffer but keep the rest (start of next sentence)
                transcriptionBuffer = parts.slice(2).join("```");
              }
            }
            // We DO NOT forward the raw transcription packet to the phone
            return;
          }
        }

        // Relay other system messages (setup_complete, etc.)
        clientSocket.send(event.data);
      } catch (e) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = () => clientSocket.close();
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});