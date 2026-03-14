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
    console.log("--- [RELAY] 🟢 STARTING MULTIMODAL SHOVEL ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Sending Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          // CRITICAL: Tell the model it has vision in the instructions
          system_instruction: { 
            parts: [{ text: "You are a visionary AI. I am sending you both audio and video frames. Describe what you see in the images and relate it to the audio." }] 
          },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      let textContent = (event.data instanceof Blob) ? await event.data.text() : (event.data instanceof ArrayBuffer) ? new TextDecoder().decode(event.data) : event.data;
      
      let data;
      try { data = JSON.parse(textContent); } catch { 
        // If not JSON, it's raw audio from AI, relay to client
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return; 
      }

      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Starting Audio & Video Shovels... ---");
        
        // --- 1. THE AUDIO SHOVEL (Already working) ---
        const { data: audioFile } = await supabase.storage.from('Audio').download('audio.pcm');
        const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
        let aOffset = 0;
        const aInterval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || aOffset >= audioBytes.length) return clearInterval(aInterval);
          const chunk = audioBytes.slice(aOffset, aOffset + 6400);
          googleSocket.send(JSON.stringify({
            realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64.encode(chunk) }] }
          }));
          aOffset += 6400;
        }, 200);

        // --- 2. THE VIDEO SHOVEL (The New Part) ---
        // We will loop through 5 frames stored in your bucket
        let frameNode = 1;
        const vInterval = setInterval(async () => {
          if (googleSocket.readyState !== WebSocket.OPEN || frameNode > 5) {
            if (frameNode > 5) {
                console.log("--- [VIDEO] 🏁 Sent all 5 frames. ---");
                // Optional: Send turn complete after video + audio are done
                googleSocket.send(JSON.stringify({ client_content: { turns: [{ role: "user", parts: [{ text: "I've sent the images and audio. What did you see?" }] }], turn_complete: true } }));
            }
            return clearInterval(vInterval);
          }

          console.log(`--- [VIDEO] 📸 Shoveling frame${frameNode}.jpg ---`);
          const { data: imgData } = await supabase.storage.from('Audio').download(`frame${frameNode}.jpg`);
          
          if (imgData) {
            const imgBytes = new Uint8Array(await imgData.arrayBuffer());
            googleSocket.send(JSON.stringify({
              realtime_input: {
                media_chunks: [{
                  mime_type: "image/jpeg",
                  data: base64.encode(imgBytes)
                }]
              }
            }));
          }
          frameNode++;
        }, 1000); // Gemini Live limit is ~1 frame per second

        return;
      }

      // Relay JSON (transcripts, etc.) to client
      const transcript = data.server_content?.output_transcription?.text || data.serverContent?.outputTranscription?.text;
      if (transcript) console.log("--- [AI] 💬:", transcript);
      
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
    };

    googleSocket.onclose = (e) => console.log("Google Closed", e.code);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});