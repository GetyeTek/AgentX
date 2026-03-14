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
    console.log("--- [RELAY] 🟢 Edge Function Connected ---");
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
          system_instruction: { 
            parts: [{ text: "You are a helpful AI with vision. Describe the images I send and summarize the audio." }] 
          },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      let data;
      let textContent = "";

      // Decode binary frames to text for JSON checking
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
        // If not JSON, it's raw audio bytes from Gemini
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      // 1. Setup Waterfall
      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Starting Pre-loaded Shovel ---");
        runPreloadedShovel(googleSocket, supabase);
        return;
      }

      // 2. Response Waterfall (Logs everything the AI says)
      const content = data.server_content || data.serverContent;
      if (content) {
        const parts = content.model_turn?.parts || content.modelTurn?.parts;
        if (parts) {
          parts.forEach(p => {
            if (p.text) console.log("--- [AI TEXT] 🧠:", p.text);
          });
        }
        const transcript = content.output_transcription?.text || content.outputTranscription?.text;
        if (transcript) console.log("--- [AI TRANSCRIPT] 💬:", transcript);
      }

      if (data.error) console.error("--- [GOOGLE ERROR] ---", JSON.stringify(data.error));

      // Relay JSON back to client
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(textContent);
    };

    googleSocket.onclose = (e) => console.log("--- [GOOGLE CLOSED] ---", e.code);
  };

  return response;
});

/**
 * PRE-LOADED SHOVEL: Downloads all assets first to avoid I/O blocking
 */
async function runPreloadedShovel(googleSocket, supabase) {
  try {
    console.log("--- [PRE-LOAD] 📥 Downloading 3 frames + audio... ---");
    
    // Download everything in parallel
    const [audioRes, f1, f2, f3] = await Promise.all([
      supabase.storage.from('Audio').download('audio.pcm'),
      supabase.storage.from('Audio').download('frame1.jpg'),
      supabase.storage.from('Audio').download('frame2.jpg'),
      supabase.storage.from('Audio').download('frame3.jpg')
    ]);

    const audioBytes = new Uint8Array(await audioRes.data.arrayBuffer());
    const frames = [
      base64.encode(new Uint8Array(await f1.data.arrayBuffer())),
      base64.encode(new Uint8Array(await f2.data.arrayBuffer())),
      base64.encode(new Uint8Array(await f3.data.arrayBuffer()))
    ];

    console.log("--- [SHOVEL] 🚀 Assets Ready. Starting Stream... ---");

    // Audio Interval (Snake Case works here)
    let aOffset = 0;
    const aInterval = setInterval(() => {
      if (googleSocket.readyState !== WebSocket.OPEN || aOffset >= audioBytes.length) return clearInterval(aInterval);
      const chunk = audioBytes.slice(aOffset, aOffset + 6400);
      googleSocket.send(JSON.stringify({
        realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64.encode(chunk) }] }
      }));
      aOffset += 6400;
    }, 200);

    // Video Loop (Serial)
    for (let i = 0; i < frames.length; i++) {
      if (googleSocket.readyState !== WebSocket.OPEN) break;
      console.log(`--- [VIDEO] 📸 Sending Frame ${i+1} ---`);
      googleSocket.send(JSON.stringify({
        realtime_input: { media_chunks: [{ mime_type: "image/jpeg", data: frames[i] }] }
      }));
      await new Promise(r => setTimeout(r, 1000));
    }

    // FINAL NUDGE: Use both naming conventions to be safe
    console.log("--- [SHOVEL] 🏁 Finalizing Turn ---");
    googleSocket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Describe the images and the audio I just sent." }] }],
        turnComplete: true
      }
    }));

  } catch (err) {
    console.error("--- [CRITICAL SHOVEL ERROR] ---", err);
  }
}