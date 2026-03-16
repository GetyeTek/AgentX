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
    let transcriptionBuffer = "";

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
              text: "You are AgentX. STRICT RULE: You must wrap every single complete sentence in triple backticks. Example: ```I see the screen.``` You must wait until the sentence is fully finished before closing the backticks. Never output text outside of backticks."
            }]
          },
          output_audio_transcription: {},
          context_window_compression: { sliding_window: { target_tokens: 15000 } }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        clientSocket.send(event.data);
        return;
      }

      try {
        const data = JSON.parse(event.data);
        const serverContent = data.server_content || data.serverContent;
        
        // 1. CATCH ANY TRANSCRIPTION (incremental chunks)
        const transcript = serverContent?.output_transcription?.text || serverContent?.outputTranscription?.text;
        if (transcript !== undefined) {
          transcriptionBuffer += transcript;

          // If we have a closed block ```...```
          if (transcriptionBuffer.includes("```")) {
            const parts = transcriptionBuffer.split("```");
            if (parts.length >= 3) {
              const coherentSentence = parts[1].trim();
              if (coherentSentence.length > 0) {
                // Send ONLY the coherent sentence as a synthetic model_turn
                clientSocket.send(JSON.stringify({
                  server_content: {
                    model_turn: {
                      parts: [{ text: coherentSentence }]
                    }
                  }
                }));
              }
              transcriptionBuffer = parts.slice(2).join("```");
            }
          }
          // IMPORTANT: Swallow the packet. Do not forward raw transcription to phone.
          return;
        }

        // 2. CATCH RAW MODEL TURNS (to prevent double-logging from Google's native end-of-turn)
        if (serverContent?.model_turn || serverContent?.modelTurn) {
          // Only allow our synthetic turns through, swallow Google's native ones
          return;
        }

        // 3. Forward everything else (setup_complete, etc.)
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