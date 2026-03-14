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
    console.log("--- [RELAY] 🟢 Multimodal Session Start ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1. Connection Setup
    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Sending Multimodal Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: { 
            parts: [{ text: "You are looking at video frames and listening to audio. Please describe the visuals in detail and respond to the audio." }] 
          },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    // 2. The Message Handler (Heavy Debugging)
    googleSocket.onmessage = async (event) => {
      let data;
      let isBinary = false;

      // Handle binary (audio chunks) or JSON
      if (event.data instanceof Blob) {
        const text = await event.data.text();
        try { data = JSON.parse(text); } catch { isBinary = true; }
      } else {
        try { data = JSON.parse(event.data); } catch { isBinary = true; }
      }

      if (isBinary) {
        // This is actual AI Voice speaking
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      // --- WATERFALL: LOG EVERYTHING ---
      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Starting Serial Shovel ---");
        startMultimodalShovel(googleSocket, supabase);
        return;
      }

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

      if (data.error) console.error("--- [GOOGLE ERROR] ---", data.error);

      // Relay JSON to client
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(JSON.stringify(data));
    };

    googleSocket.onclose = (e) => console.log("--- [GOOGLE CLOSED] ---", e.code, e.reason);
  };

  return response;
});

/**
 * Serial Shoveler: Ensures downloads and sends happen in order 
 * to prevent the 'Silent Hang' caused by overlapping intervals.
 */
async function startMultimodalShovel(googleSocket, supabase) {
  try {
    // A. FETCH THE FILES ONCE
    console.log("--- [SHOVEL] 📥 Downloading Assets... ---");
    const { data: audioData } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBytes = new Uint8Array(await audioData.arrayBuffer());

    // B. START AUDIO LOOP (Async but controlled)
    let aOffset = 0;
    const aInterval = setInterval(() => {
      if (googleSocket.readyState !== WebSocket.OPEN || aOffset >= audioBytes.length) return clearInterval(aInterval);
      const chunk = audioBytes.slice(aOffset, aOffset + 6400);
      googleSocket.send(JSON.stringify({
        realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64.encode(chunk) }] }
      }));
      aOffset += 6400;
    }, 200);

    // C. START VIDEO LOOP (Serial for stability)
    for (let frame = 1; frame <= 5; frame++) {
      if (googleSocket.readyState !== WebSocket.OPEN) break;
      
      console.log(`--- [VIDEO] 📸 Sending frame${frame}.jpg ---`);
      const { data: imgData } = await supabase.storage.from('Audio').download(`frame${frame}.jpg`);
      
      if (imgData) {
        const imgBytes = new Uint8Array(await imgData.arrayBuffer());
        googleSocket.send(JSON.stringify({
          realtime_input: { media_chunks: [{ mime_type: "image/jpeg", data: base64.encode(imgBytes) }] }
        }));
      }
      
      // Wait exactly 1 second before the next frame (Gemini limit)
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log("--- [SHOVEL] 🏁 Frames sent. Finalizing turn. ---");
    
    // D. TRIGGER THE RESPONSE
    googleSocket.send(JSON.stringify({
      client_content: {
        turns: [{ role: "user", parts: [{ text: "I have sent you the visuals and the audio. What is happening in the video?" }] }],
        turn_complete: true
      }
    }));

  } catch (err) {
    console.error("--- [SHOVEL ERROR] ---", err);
  }
}