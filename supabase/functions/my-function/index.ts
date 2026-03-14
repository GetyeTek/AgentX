import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import * as base64 from "https://deno.land/std@0.207.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Ensuring model string is exactly as expected by the Bidi endpoint
const MODEL = "models/gemini-2.0-flash-exp"; 
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 Client Connected ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Opened. Sending Setup... ---");
      
      // VALIDATED SCHEMA PER DOCUMENTATION
      const setupMsg = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: "Puck" // Must be one of: Puck, Charon, Kore, Fenrir, Aoede
                }
              }
            }
          },
          system_instruction: {
            parts: [{ text: "You are a helpful assistant. Introduction yourself briefly." }]
          },
          // Enabling these allows us to see text in the logs while streaming audio
          input_audio_transcription: { enabled: true },
          output_audio_transcription: { enabled: true }
        }
      };

      console.log("--- [DEBUG] Sending Setup JSON:", JSON.stringify(setupMsg));
      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.error("--- [ERROR] Failed to parse Google message:", event.data);
        return;
      }

      // Handle Setup Completion
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Accepted. Fetching audio.pcm... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const arrayBuffer = await fileData.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const chunkSize = 6400; // 200ms of 16kHz 16-bit PCM

        console.log(`--- [SHOVEL] 📦 File size: ${uint8Array.length} bytes. Starting stream... ---`);

        let offset = 0;
        const streamInterval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            console.log("--- [SHOVEL] 🏁 Stream finished or socket closed ---");
            clearInterval(streamInterval);
            return;
          }

          const chunk = uint8Array.slice(offset, offset + chunkSize);
          const encodedData = base64.encode(chunk);

          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: encodedData
              }]
            }
          }));

          offset += chunkSize;
          if (offset % (chunkSize * 10) === 0) {
            console.log(`--- [SHOVEL] 📤 Sent ${offset}/${uint8Array.length} bytes... ---`);
          }
        }, 200); // Send every 200ms to mimic real-time
        
        return;
      }

      // DEBUGGING: Log Transcriptions if they exist
      const transcription = data.server_content?.output_transcription?.text;
      if (transcription) {
        console.log("--- [AI TEXT] 💬:", transcription);
      }

      // Forward audio data or other events to the client
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "No reason provided"} ---`);
      if (e.code === 1007) {
        console.error("--- [CRITICAL] 1007 means 'Invalid Argument'. Check the Setup JSON structure above. ---");
      }
      clientSocket.close();
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE ERROR] ❌ ---", err);

    clientSocket.onclose = () => {
      console.log("--- [RELAY] ⚪ Client disconnected ---");
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});