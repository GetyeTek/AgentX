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
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = async () => {
    console.log("--- [RELAY] 🟢 SESSION START ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let isSetupConfirmed = false;

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Connected. Sending Setup... ---");
      // FIXED SETUP: Based on working Python template logic
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            // The preview model prefers just AUDIO as the response modality
            response_modalities: ["AUDIO"] 
          }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Confirmed! Downloading audio.pcm... ---");
        isSetupConfirmed = true;
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 3200; // 100ms of PCM

        console.log(`--- [SHOVEL] 📦 Streaming ${uint8Array.length} bytes ---`);

        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          if (googleSocket.readyState !== WebSocket.OPEN) break;

          const chunk = uint8Array.slice(i, i + chunkSize);
          
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                // FIXED MIME: Just 'audio/pcm', no rate string
                mime_type: "audio/pcm",
                data: base64.encode(chunk)
              }]
            }
          }));

          // Pacing: exactly 100ms
          await new Promise(r => setTimeout(r, 100)); 
        }
        
        console.log("--- [SHOVEL] 🏁 Finished sending file ---");
        return;
      }

      // Relay Gemini's audio responses back to the client (Android/Browser)
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason} ---`);
    };

    googleSocket.onerror = (err) => console.error("Google Error", err);
    
    clientSocket.onclose = () => {
        console.log("--- [CLIENT] ⚪ Disconnected ---");
        if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});