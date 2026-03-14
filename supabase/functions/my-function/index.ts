import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import * as base64 from "https://deno.land/std@0.207.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
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
    console.log("--- [RELAY] 🟢 STARTING ---");
    
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // This ensures binary messages are easier to handle, though we primarily expect JSON strings wrapped in binary frames
    googleSocket.binaryType = "arraybuffer";

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Opened. Sending Setup... ---");
      
      const setupMsg = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: "Puck" 
                }
              }
            }
          },
          system_instruction: {
            parts: [{ text: "You are a helpful assistant." }]
          },
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      };

      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      let rawData = event.data;

      // FIX: Handle Blob/ArrayBuffer data from Deno's WebSocket
      if (rawData instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(rawData);
      } else if (typeof rawData !== "string") {
        // Handle Blob if binaryType wasn't set or supported
        rawData = await rawData.text();
      }

      let data;
      try {
        data = JSON.parse(rawData);
      } catch (e) {
        console.error("--- [ERROR] JSON Parse Fail. Raw data length:", rawData.length);
        console.error("--- [ERROR] Content snippet:", rawData.slice(0, 100));
        return;
      }

      // 1. Handle Setup Confirmation
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Accepted. Downloading PCM... ---");
        
        const { data: fileData, error } = await supabase.storage
          .from('Audio')
          .download('audio.pcm');

        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; // 200ms

        console.log(`--- [SHOVEL] 📦 Streaming ${uint8Array.length} bytes ---`);

        let offset = 0;
        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            clearInterval(interval);
            console.log("--- [SHOVEL] 🏁 Stream complete ---");
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
        }, 200); 

        return;
      }

      // 2. Log Debug Info (Transcriptions)
      const aiText = data.server_content?.output_transcription?.text;
      if (aiText) console.log("--- [AI TEXT] 🧠:", aiText);

      // 3. Forward message back to client (Frontend)
      if (clientSocket.readyState === WebSocket.OPEN) {
        // Send the raw original data (Google likes strings or binary)
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "None"} ---`);
      clientSocket.close();
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE ERROR] ❌ ---", err);

    clientSocket.onclose = () => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});