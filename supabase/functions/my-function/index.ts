import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-client@2.39.7";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = async () => {
    console.log("--- [RELAY] 🟢 Starting Bucket-to-Gemini Shovel ---");
    
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const cleanup = () => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Handshaking... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: {
            parts: [{ text: "You are an audio analyzer. Just tell me if you hear this audio clearly." }]
          }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Fetching from Bucket... ---");
        
        // 1. Fetch file from Supabase Storage
        const { data: fileData, error } = await supabase
          .storage
          .from('Audio')
          .download('test.mp3');

        if (error || !fileData) {
          console.error("--- [STORAGE ERROR] ❌ ---", error);
          return;
        }

        console.log(`--- [SHOVEL] 📦 Got file (${fileData.size} bytes). Streaming now... ---`);

        // 2. Convert to ArrayBuffer
        const arrayBuffer = await fileData.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // 3. Shovel it in chunks (approx 100ms chunks of bytes)
        // Even if it's MP3, we send it to see if the 1007 goes away.
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

          // Tiny delay to prevent flooding the socket too fast
          await new Promise(r => setTimeout(r, 20)); 
        }
        
        console.log("--- [SHOVEL] 🏁 Finished sending file ---");
        return;
      }

      // Log what Gemini says back
      if (data.server_content?.model_turn?.parts?.[0]?.text) {
        console.log("--- [AI] 🧠:", data.server_content.model_turn.parts[0].text);
      }

      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE] 🚫 CLOSED: ${e.code} / ${e.reason} ---`);
      cleanup();
    };

    googleSocket.onerror = (err) => console.error("Google Error", err);
    clientSocket.onclose = () => cleanup();
  };

  return response;
});