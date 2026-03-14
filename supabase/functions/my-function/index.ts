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
    console.log("--- [RELAY] 🟢 Session Started ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Connected. Sending Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: { 
            parts: [{ text: "You are a helpful AI with vision. Describe the visuals and audio provided." }] 
          }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      let data;
      let textContent = "";

      // Handle binary frames (common in Deno for Google WS)
      if (event.data instanceof Blob) {
        textContent = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        textContent = new TextDecoder().decode(event.data);
      } else {
        textContent = event.data;
      }

      try {
        data = JSON.parse(textContent);
      } catch {
        // If not JSON, it's raw AI audio. Relay to frontend immediately.
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      // Check for Setup Success
      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Starting Optimized Stream... ---");
        runOptimizedMultimodalStream(googleSocket, supabase);
        return;
      }

      // Log AI responses
      const content = data.server_content || data.serverContent;
      if (content) {
        const text = content.model_turn?.parts?.[0]?.text || content.output_transcription?.text;
        if (text) console.log("--- [AI RESPONSE] 🧠:", text);
      }

      // Relay all other JSON messages (like transcriptions) to the client
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(textContent);
    };

    googleSocket.onclose = (e) => console.warn(`--- [GOOGLE CLOSED] Code: ${e.code} ---`);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});

/**
 * MEMORY-OPTIMIZED STREAMER
 * Downloads and processes frames one-by-one to prevent OOM crashes.
 */
async function runOptimizedMultimodalStream(googleSocket, supabase) {
  try {
    // 1. Download Audio (Necessary to have in buffer for the interval)
    console.log("--- [STREAM] 📥 Downloading Audio... ---");
    const { data: audioData } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBytes = new Uint8Array(await audioData.arrayBuffer());

    // 2. Start Audio Interval (Low memory overhead)
    let aOffset = 0;
    const aInterval = setInterval(() => {
      if (googleSocket.readyState !== WebSocket.OPEN || aOffset >= audioBytes.length) {
        return clearInterval(aInterval);
      }
      const chunk = audioBytes.slice(aOffset, aOffset + 6400);
      googleSocket.send(JSON.stringify({
        realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64.encode(chunk) }] }
      }));
      aOffset += 6400;
    }, 200);

    // 3. Start Video Loop (Download-Send-Discard pattern)
    console.log("--- [STREAM] 📸 Starting Sequential Video Stream... ---");
    for (let i = 1; i <= 3; i++) {
      if (googleSocket.readyState !== WebSocket.OPEN) break;

      console.log(`--- [VIDEO] 📥 Fetching & Sending Frame ${i}... ---`);
      const { data: imgData, error } = await supabase.storage.from('Audio').download(`frame${i}.jpg`);
      
      if (!error && imgData) {
        const imgBytes = new Uint8Array(await imgData.arrayBuffer());
        googleSocket.send(JSON.stringify({
          realtime_input: {
            media_chunks: [{
              mime_type: "image/jpeg",
              data: base64.encode(imgBytes)
            }]
          }
        }));
        // Small delay to let GC work and Google process
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 4. Final Trigger
    console.log("--- [STREAM] 🏁 Finished. Nudging AI... ---");
    googleSocket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "I've sent the images and audio. Tell me what you saw." }] }],
        turnComplete: true
      }
    }));

  } catch (err) {
    console.error("--- [STREAM CRASH] ---", err);
  }
}