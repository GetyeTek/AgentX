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

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Handshaking... ---");
      // CRITICAL FIX: We MUST ask for AUDIO modality and provide a voice
      // even if we only want text. This prevents the 1007 "Non-audio request" error.
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            response_modalities: ["AUDIO", "TEXT"] // MUST include AUDIO
          },
          speech_config: {
            voice_config: { prebuilt_voice_config: { voice_name: "Puck" } }
          },
          system_instruction: { 
            parts: [{ text: "You are an audio analyzer. Tell me exactly what you hear." }] 
          }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Connected! Shoveling PCM... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        
        // Use a 100ms chunk (16000 samples * 2 bytes per sample / 10 chunks per sec = 3200)
        const chunkSize = 3200; 

        // CRITICAL FIX: The first message AFTER setup MUST contain text AND audio
        // to "wake up" the voice activity detector.
        if (uint8Array.length > 0) {
            const firstChunk = uint8Array.slice(0, chunkSize);
            googleSocket.send(JSON.stringify({
                realtime_input: {
                    media_chunks: [{
                        mime_type: "audio/pcm;rate=16000",
                        data: base64.encode(firstChunk)
                    }],
                    // Forcing a text trigger with the first audio chunk
                    text: "Starting audio stream now. Analyze this."
                }
            }));
        }

        // Shovel the rest
        for (let i = chunkSize; i < uint8Array.length; i += chunkSize) {
          if (googleSocket.readyState !== WebSocket.OPEN) break;

          const chunk = uint8Array.slice(i, i + chunkSize);
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: base64.encode(chunk)
              }]
            }
          }));

          await new Promise(r => setTimeout(r, 100)); 
        }
        
        console.log("--- [SHOVEL] 🏁 Finished ---");
        return;
      }

      // Log AI responses
      if (data.server_content?.model_turn?.parts?.[0]?.text) {
        console.log("--- [AI] 🧠:", data.server_content.model_turn.parts[0].text);
      }
      
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
    };

    googleSocket.onclose = (e) => console.warn(`--- [GOOGLE CLOSED] 🚫 ${e.code}: ${e.reason} ---`);
    clientSocket.onclose = () => { if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close(); };
  };

  return response;
});