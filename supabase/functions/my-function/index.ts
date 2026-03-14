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

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 STARTING ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    googleSocket.binaryType = "arraybuffer"; // Essential for handling binary responses

    // 1. Monitor connection phase
    const connectionTimeout = setTimeout(() => {
      if (googleSocket.readyState !== WebSocket.OPEN) {
        console.error("--- [TIMEOUT] ⏳ Google Socket failed to reach OPEN state ---");
      }
    }, 5000);

    googleSocket.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log("--- [GOOGLE] 🔵 Socket Opened. Sending Setup... ---");
      
      // THIS STRUCTURE IS DERIVED DIRECTLY FROM THE gemini_live.py LOGIC
      const setupMsg = {
        setup: {
          model: MODEL,
          // In the Live API, these are siblings under the 'setup' or 'config' umbrella
          generation_config: {
            response_modalities: ["AUDIO"]
          },
          speech_config: {
            voice_config: {
              prebuilt_voice_config: {
                voice_name: "Puck"
              }
            }
          },
          system_instruction: {
            parts: [{ text: "You are a helpful AI assistant." }]
          }
        }
      };

      googleSocket.send(JSON.stringify(setupMsg));
      console.log("--- [SENT] 📤 Setup message dispatched ---");
    };

    googleSocket.onmessage = async (event) => {
      // DEBUG: Log that we received SOMETHING
      console.log(`--- [RECEIVE] 📥 Message received (Type: ${typeof event.data}, Length: ${event.data.byteLength || event.data.length}) ---`);

      let rawData = event.data;
      if (rawData instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(rawData);
      } else if (typeof rawData !== "string") {
        rawData = await rawData.text();
      }

      let data;
      try {
        data = JSON.parse(rawData);
      } catch (e) {
        console.error("--- [ERROR] JSON Parse Fail. Content:", rawData.slice(0, 50));
        return;
      }

      // Handle Setup Success
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Accepted. Proceeding to Shovel... ---");
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; // 200ms
        let offset = 0;

        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            clearInterval(interval);
            console.log("--- [SHOVEL] 🏁 Stream End ---");
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

      // Handle Model Responses / Transcriptions
      if (data.server_content) {
        if (data.server_content.model_turn) {
           console.log("--- [AI RESPONSE] 🔊 Audio Chunk Received ---");
        }
        if (data.server_content.output_transcription) {
           console.log("--- [AI TEXT] 🧠:", data.server_content.output_transcription.text);
        }
      }

      // Relay everything to the frontend
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "No Reason"} ---`);
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