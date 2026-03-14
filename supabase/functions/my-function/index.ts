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
    console.log("--- [RELAY] 🟢 Vision-Only Session Started ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1. Setup Connection with Vision-Focused Instructions
    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Sending Vision Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: { 
            parts: [{ 
              text: `You are a visual analysis expert. 
                     IGNORE ALL AUDIO. Even if you hear sounds, do not mention them. 
                     Describe the images I send in vivid detail. 
                     When you see a new frame, provide a short, real-time commentary on what you see.` 
            }] 
          },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    // 2. Incoming Message Handler (Waterfall Logic)
    googleSocket.onmessage = async (event) => {
      let data;
      let textContent = "";

      // Decode Binary Frames
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
        // Raw AI Audio data (the voice describing the image)
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      // Check for Setup Success
      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Vision Setup Ready. Starting Frame Stream... ---");
        runVisionOnlyStream(googleSocket, supabase);
        return;
      }

      // Log AI visual analysis
      const content = data.server_content || data.serverContent;
      if (content) {
        const text = content.model_turn?.parts?.[0]?.text || content.output_transcription?.text;
        if (text) console.log("--- [AI VISION ANALYSIS] 👁️:", text);
      }

      // Relay everything else to client
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(textContent);
    };

    googleSocket.onclose = (e) => console.warn(`--- [GOOGLE CLOSED] Code: ${e.code} ---`);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});

/**
 * VISION-ONLY STREAMER
 * Downloads and sends images one by one.
 * Audio is completely omitted from this logic.
 */
async function runVisionOnlyStream(googleSocket, supabase) {
  try {
    console.log("--- [STREAM] 📸 Starting Sequential Vision Stream (3 Frames) ---");
    
    for (let i = 1; i <= 3; i++) {
      if (googleSocket.readyState !== WebSocket.OPEN) break;

      console.log(`--- [VIDEO] 📥 Fetching & Sending Frame ${i}... ---`);
      const { data: imgData, error } = await supabase.storage.from('Audio').download(`frame${i}.jpg`);
      
      if (!error && imgData) {
        const imgBytes = new Uint8Array(await imgData.arrayBuffer());
        
        // Send the Image
        googleSocket.send(JSON.stringify({
          realtime_input: {
            media_chunks: [{
              mime_type: "image/jpeg",
              data: base64.encode(imgBytes)
            }]
          }
        }));

        // AUTOMATIC NUDGE: Force Gemini to talk about THIS specific frame immediately
        googleSocket.send(JSON.stringify({
          client_content: {
            turns: [{ role: "user", parts: [{ text: `I just sent frame ${i}. What do you see?` }] }],
            turn_complete: true
          }
        }));

        // Wait 2 seconds between frames to let the AI finish its description
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    console.log("--- [STREAM] 🏁 Finished sending images. Waiting 20s for final thoughts... ---");
    await new Promise(r => setTimeout(r, 20000));
    console.log("--- [RELAY] 🏁 Session Complete. ---");

  } catch (err) {
    console.error("--- [STREAM ERROR] ---", err);
  }
}