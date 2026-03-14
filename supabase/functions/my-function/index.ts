import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-client@2.39.7";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket request", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = async () => {
    console.log("--- [RELAY] 🟢 SESSION START ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Handshaking... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: { parts: [{ text: "You are an audio analyzer. Tell me exactly what you hear in this file." }] }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Fetching audio.pcm... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        console.log(`--- [SHOVEL] 📦 Streaming ${uint8Array.length} bytes of PCM ---`);

        // MATH: 16000Hz * 16-bit(2 bytes) = 32,000 bytes per second.
        // We send 3200 bytes (100ms of audio) every 100ms.
        const chunkSize = 3200; 
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          if (googleSocket.readyState !== WebSocket.OPEN) break;

          const chunk = uint8Array.slice(i, i + chunkSize);
          const base64Chunk = btoa(String.fromCharCode(...chunk));

          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: base64Chunk
              }]
            }
          }));

          // Wait exactly 100ms to simulate real-time talking
          await new Promise(r => setTimeout(r, 100)); 
        }
        
        console.log("--- [SHOVEL] 🏁 Finished ---");
        return;
      }

      if (data.server_content?.model_turn?.parts?.[0]?.text) {
        console.log("--- [AI RESPONSE] 🧠:", data.server_content.model_turn.parts[0].text);
      }
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
    };

    googleSocket.onclose = (e) => console.warn(`--- [GOOGLE CLOSED] 🚫 ${e.code}: ${e.reason} ---`);
    clientSocket.onclose = () => {
        if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});