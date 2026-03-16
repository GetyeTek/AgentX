import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "gemini-2.0-flash-exp"; // or gemini-2.5-flash-native-audio-preview-12-2025

serve(async (req) => {
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("Client connected, initializing Gemini session...");
    
    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const geminiSocket = new WebSocket(geminiUrl);

    // 1. Setup Gemini with Context Compression
    geminiSocket.onopen = () => {
      const setupMessage = {
        setup: {
          model: `models/${MODEL}`,
          generation_config: {
            response_modalities: ["AUDIO"],
            context_window_compression: {
              sliding_window: { 
                // Max tokens before pruning oldest context (approx 10-15 mins of 1fps images)
                max_token_count: 40000 
              }
            }
          },
          system_instruction: {
            parts: [{ text: "You are AgentX. Focus entirely on the UI images provided. Describe the state (Online/Offline) and buttons. Ignore background audio noise. Do not hallucinate banking info." }]
          }
        }
      };
      geminiSocket.send(JSON.stringify(setupMessage));
    };

    // 2. Transform Incoming Stream to Inline
    clientSocket.onmessage = (event) => {
      if (geminiSocket.readyState !== WebSocket.OPEN) return;

      try {
        const data = JSON.parse(event.data);
        
        // INTERCEPT: If it's an image in the stream, convert it to inline client_content
        if (data.realtime_input?.media_chunks) {
          const imageChunk = data.realtime_input.media_chunks.find(c => c.mime_type === 'image/jpeg');
          const audioChunks = data.realtime_input.media_chunks.filter(c => c.mime_type.startsWith('audio/'));

          if (imageChunk) {
            // Send as Inline Turn (Prevents Hallucination)
            const inlinePayload = {
              client_content: {
                turns: [{
                  role: "user",
                  parts: [{ inline_data: { data: imageChunk.data, mime_type: "image/jpeg" } }]
                }],
                turn_complete: false
              }
            };
            geminiSocket.send(JSON.stringify(inlinePayload));
          }

          if (audioChunks.length > 0) {
            // Keep audio in the raw stream (Good for low latency audio processing)
            geminiSocket.send(event.data);
          }
        } else {
          // Relay other messages (Nudges, text) as is
          geminiSocket.send(event.data);
        }
      } catch (e) {
        // If not JSON, relay raw bytes (usually audio response from model)
        geminiSocket.send(event.data);
      }
    };

    geminiSocket.onmessage = (event) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    geminiSocket.onclose = () => clientSocket.close();
    clientSocket.onclose = () => geminiSocket.close();
  };

  return response;
});