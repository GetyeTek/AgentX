import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import * as base64 from "https://deno.land/std@0.207.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// The model string from your documentation
const MODEL = "models/gemini-2.0-flash-exp"; 
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 STARTING PCM SHOVEL ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Opened. Sending Setup... ---");
      
      // STRICT PROTOCOL SCHEMA:
      // 1. speech_config MUST be inside generation_config.
      // 2. Transcriptions must be empty objects {}, not have an "enabled" field.
      const setupMsg = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: "Puck" // Options: Puck, Charon, Kore, Fenrir, Aoede
                }
              }
            }
          },
          system_instruction: {
            parts: [{ text: "You are a helpful AI assistant. Respond briefly and naturally." }]
          },
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      };

      console.log("--- [DEBUG] Sending Setup Payload:", JSON.stringify(setupMsg, null, 2));
      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      // 1. Handle Setup Completion
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Accepted. Fetching audio.pcm... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; // 200ms of 16kHz PCM (Standard for Live API)

        console.log(`--- [SHOVEL] 📦 File loaded: ${uint8Array.length} bytes. Shoveling... ---`);

        let offset = 0;
        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            console.log("--- [SHOVEL] 🏁 Finished sending file or socket closed ---");
            clearInterval(interval);
            return;
          }

          const chunk = uint8Array.slice(offset, offset + chunkSize);
          
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: base64.encode(chunk)
              }]
            }
          }));

          offset += chunkSize;
          if (offset % (chunkSize * 5) === 0) {
            console.log(`--- [SHOVEL] 📤 Progress: ${offset} / ${uint8Array.length} bytes sent`);
          }
        }, 200); // 200ms interval to prevent buffer overflow
        
        return;
      }

      // 2. Handle Audio Data (Forward to Client)
      if (data.server_content?.model_turn?.parts?.[0]?.inline_data) {
          // You can log size but don't log raw audio bytes
          // console.log("--- [GOOGLE] 🔊 Received Audio Chunk ---");
      }

      // 3. Debug Transcriptions
      const transcript = data.server_content?.output_transcription?.text;
      if (transcript) {
        console.log("--- [AI TRANSCRIPT] 🧠:", transcript);
      }

      // 4. Relay everything back to the frontend/client
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason} ---`);
      if (e.code === 1007) {
        console.error("--- [PROTOCOL ERROR] 1007 indicates a field name mismatch. Ensure speech_config is in generation_config. ---");
      }
      clientSocket.close();
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE ERROR] ❌ ---", err);

    clientSocket.onclose = () => {
      console.log("--- [RELAY] ⚪ Client session ended ---");
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});