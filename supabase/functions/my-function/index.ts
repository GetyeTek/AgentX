import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import * as base64 from "https://deno.land/std@0.207.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Using your requested model
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 Edge Function Connected ---");
    
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Setup a hang-detector
    const setupTimeout = setTimeout(() => {
      console.error("--- [DEBUG] ⏳ Setup Timeout: Google never sent setup_complete! ---");
    }, 10000);

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
          // Some versions of the API reject empty transcription objects if not supported
          // If it still hangs, we will try removing these two lines entirely.
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      };

      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      // 🟢 DEBUG: LOG EVERY MESSAGE TYPE
      console.log(`--- [GOOGLE] 📩 Received message. Type: ${typeof event.data}, Prototype: ${event.data?.constructor?.name}`);

      let rawData = event.data;

      // Robust decoding for Blobs (Deno/Edge specific)
      if (rawData instanceof Blob) {
        rawData = await rawData.text();
      } else if (rawData instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(rawData);
      }

      let data;
      try {
        data = JSON.parse(rawData);
        console.log("--- [GOOGLE] 📦 Parsed JSON:", JSON.stringify(data).slice(0, 150), "...");
      } catch (e) {
        console.error("--- [ERROR] JSON Parse Failed. First 50 chars:", String(rawData).slice(0, 50));
        return;
      }

      // Handle Setup Completion
      if (data.setup_complete) {
        clearTimeout(setupTimeout);
        console.log("--- [GOOGLE] ✅ Setup Accepted! ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) return console.error("--- [STORAGE ERROR] ❌ ---", error);

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; 

        console.log(`--- [SHOVEL] 📦 Streaming PCM bytes... ---`);

        let offset = 0;
        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            clearInterval(interval);
            console.log("--- [SHOVEL] 🏁 Finished ---");
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

      // Transcriptions or Audio data
      if (data.server_content) {
        const text = data.server_content.model_turn?.parts?.[0]?.text || data.server_content.output_transcription?.text;
        if (text) console.log("--- [AI TEXT] 🧠:", text);
      }

      // Relay to frontend
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      clearTimeout(setupTimeout);
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "None"} ---`);
      clientSocket.close();
    };

    googleSocket.onerror = (err) => {
      console.error("--- [GOOGLE ERROR] ❌ ---", err);
    };

    clientSocket.onclose = () => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});