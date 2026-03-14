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
    console.log("--- [RELAY] 🟢 Session Active ---");
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
            parts: [{ text: "You are a helpful AI assistant. You will receive 3 images and some audio. Describe the content of the images in detail and respond to the audio." }] 
          },
          // Enabling transcriptions so we see text in logs
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      let data;
      let textContent = "";

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
        // Raw binary audio from AI
        console.log(`--- [GOOGLE] 🔊 AI is speaking (${event.data.size || event.data.byteLength} bytes) ---`);
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      // 1. Setup Success Waterfall
      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Starting Stream... ---");
        runSession(googleSocket, supabase);
        return;
      }

      // 2. Transcription/Text Logic
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

      // Relay everything else (including potential JSON audio chunks)
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(textContent);
    };

    googleSocket.onclose = (e) => console.log("--- [GOOGLE CLOSED] ---", e.code);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});

/**
 * Main Session Logic
 * Sequentially streams data then waits for response
 */
async function runSession(googleSocket, supabase) {
  try {
    // A. FETCH ASSETS
    const { data: audioData } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBytes = new Uint8Array(await audioData.arrayBuffer());

    // B. START AUDIO (Background Interval)
    let aOffset = 0;
    const aInterval = setInterval(() => {
      if (googleSocket.readyState !== WebSocket.OPEN || aOffset >= audioBytes.length) return clearInterval(aInterval);
      const chunk = audioBytes.slice(aOffset, aOffset + 6400);
      googleSocket.send(JSON.stringify({
        realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64.encode(chunk) }] }
      }));
      aOffset += 6400;
    }, 200);

    // C. START VIDEO (Sequential)
    for (let i = 1; i <= 3; i++) {
      if (googleSocket.readyState !== WebSocket.OPEN) break;
      const { data: img } = await supabase.storage.from('Audio').download(`frame${i}.jpg`);
      if (img) {
        const bytes = new Uint8Array(await img.arrayBuffer());
        googleSocket.send(JSON.stringify({
          realtime_input: { media_chunks: [{ mime_type: "image/jpeg", data: base64.encode(bytes) }] }
        }));
        console.log(`--- [STREAM] 📸 Sent Frame ${i} ---`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // D. THE FINAL NUDGE
    console.log("--- [STREAM] 🏁 Sending Final Nudge. Waiting for AI... ---");
    googleSocket.send(JSON.stringify({
      client_content: {
        turns: [{ role: "user", parts: [{ text: "Please describe the 3 frames and the audio I just sent." }] }],
        turn_complete: true
      }
    }));

    // E. PERSISTENCE MANTRA
    // We wait 30 seconds after the nudge to keep the function alive for the AI response
    await new Promise(r => setTimeout(r, 30000));
    console.log("--- [RELAY] 🏁 Session Timeout reached. Cleaning up. ---");

  } catch (err) {
    console.error("--- [CRITICAL ERROR] ---", err);
  }
}