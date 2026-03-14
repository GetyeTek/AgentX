import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import * as base64 from "https://deno.land/std@0.207.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Using your exact requested model endpoint
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 STARTING CONNECTION ---");
    
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Opened. Sending Configured Setup... ---");
      
      /**
       * STRUCTURE NOTES:
       * 1. speech_config MUST be inside generation_config (fixes your 1007 'Unknown name' error).
       * 2. transcription fields MUST be empty objects {} (fixes your 'Unknown name enabled' error).
       * 3. model MUST match your specific 2.5-flash-native-audio string.
       */
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
            parts: [{ text: "You are a helpful assistant. Introduction yourself briefly." }]
          },
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      };

      console.log("--- [DEBUG] Outgoing Setup JSON:", JSON.stringify(setupMsg, null, 2));
      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.error("--- [ERROR] JSON Parse Fail:", event.data);
        return;
      }

      // 1. Handle Setup Confirmation
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Complete. Fetching PCM Shovel... ---");
        
        const { data: fileData, error } = await supabase.storage
          .from('Audio')
          .download('audio.pcm');

        if (error || !fileData) {
          console.error("--- [SUPABASE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; // ~200ms of 16kHz 16-bit PCM

        console.log(`--- [SHOVEL] 📦 Streaming ${uint8Array.length} bytes ---`);

        let offset = 0;
        const shovelInterval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            console.log("--- [SHOVEL] 🏁 Finished sending file or Socket Closed ---");
            clearInterval(shovelInterval);
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
             console.log(`--- [SHOVEL] 📤 Progress: ${((offset/uint8Array.length)*100).toFixed(1)}% ---`);
          }
        }, 200); // 200ms pacing to prevent buffer overflow 1007 errors

        return;
      }

      // 2. Handle Server Content (Transcriptions)
      const aiTranscription = data.server_content?.output_transcription?.text;
      if (aiTranscription) {
        console.log("--- [AI TEXT] 🧠:", aiTranscription);
      }

      const userTranscription = data.server_content?.input_transcription?.text;
      if (userTranscription) {
        console.log("--- [USER TEXT] 🗣️:", userTranscription);
      }

      // 3. Relay everything back to the client (Audio PCM chunks, etc.)
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "Unknown"} ---`);
      if (e.code === 1007) {
        console.error("--- [CRITICAL] Error 1007: The JSON structure or an argument is still being rejected by Google. Check nesting of speech_config inside generation_config. ---");
      }
      clientSocket.close();
    };

    googleSocket.onerror = (err) => {
      console.error("--- [GOOGLE ERROR] ❌ ---", err);
    };

    clientSocket.onclose = () => {
      console.log("--- [RELAY] ⚪ Client disconnected ---");
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});