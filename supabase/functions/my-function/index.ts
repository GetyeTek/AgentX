import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import * as base64 from "https://deno.land/std@0.207.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Ensure the model matches the Bidi endpoint capability
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
      console.log("--- [GOOGLE] 🔵 Sending Corrected Setup... ---");
      
      /**
       * CORRECTED JSON STRUCTURE PER DOCUMENTATION:
       * 1. speech_config is a DIRECT child of 'setup'
       * 2. transcription configs are empty objects {} to enable defaults
       */
      const setupMsg = {
        setup: {
          model: MODEL,
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
            parts: [{ text: "You are a helpful assistant. Introduction yourself briefly." }]
          },
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      };

      console.log("--- [DEBUG] Payload:", JSON.stringify(setupMsg));
      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      // 1. Handle Setup Complete
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Accepted. Fetching audio.pcm... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        
        // 3200 bytes = 100ms of 16kHz 16-bit mono PCM
        const chunkSize = 3200; 
        console.log(`--- [SHOVEL] 📦 Streaming ${uint8Array.length} bytes ---`);

        let offset = 0;
        const streamInterval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            console.log("--- [SHOVEL] 🏁 Finished sending file or connection lost ---");
            clearInterval(streamInterval);
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
        }, 100); // Send one 100ms chunk every 100ms (Real-time speed)
        
        return;
      }

      // 2. Handle Transcription Debugging
      const userText = data.server_content?.input_transcription?.text;
      const aiText = data.server_content?.output_transcription?.text;
      
      if (userText) console.log("--- [USER SPEECH] 👤:", userText);
      if (aiText) console.log("--- [AI RESPONSE] 🧠:", aiText);

      // 3. Relay everything back to the client (Audio bytes + JSON)
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason} ---`);
      if (e.code === 1007) {
        console.error("--- [HINT] 1007 = Invalid Argument. Usually the 'setup' JSON is rejected by the API schema. ---");
      }
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE ERROR] ❌ ---", err);

    clientSocket.onclose = () => { 
        console.log("--- [RELAY] ⚪ Client disconnected ---");
        if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close(); 
    };
  };

  return response;
});