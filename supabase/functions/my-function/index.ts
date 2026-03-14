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
      console.log("--- [GOOGLE] 🔵 Sending Setup Message... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { 
            response_modalities: ["AUDIO"],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
          },
          system_instruction: { parts: [{ text: "You are a helpful AI. Listen to this audio and respond to it." }] },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      let data;
      let isBinary = false;

      // --- SMART DECODER ---
      // Try to treat as text first (even if it's a Blob)
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
      } catch (_e) {
        // If it's not valid JSON, it's actual raw PCM audio data from the AI
        isBinary = true;
      }

      // 1. Handle Raw Audio Binary from AI
      if (isBinary) {
        const size = event.data.size || event.data.byteLength || 0;
        console.log(`--- [GOOGLE] 🔊 Received Raw Audio Bytes: ${size} ---`);
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      // 2. Handle JSON: Setup Completion
      const isSetupReady = data.setup_complete || data.setupComplete;
      if (isSetupReady) {
        console.log("--- [GOOGLE] ✅ Setup Confirmed. Shoveling Audio... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) return console.error("--- [STORAGE ERROR] ---", error);

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; // 200ms
        let offset = 0;

        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            clearInterval(interval);
            console.log("--- [SHOVEL] 🏁 Stream finished. Closing Turn... ---");
            
            // Send end-of-turn signal to force AI to respond
            googleSocket.send(JSON.stringify({
              client_content: {
                turns: [{ role: "user", parts: [{ text: "End of audio. Please respond." }] }],
                turn_complete: true
              }
            }));
            return;
          }

          const chunk = uint8Array.slice(offset, offset + chunkSize);
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: base64.encode(chunk)
              }]
            }
          }));

          offset += chunkSize;
          if (offset % 64000 === 0) console.log(`--- [SHOVEL] 📤 Progress: ${offset} bytes ---`);
        }, 200);
        return;
      }

      // 3. Handle JSON: Transcriptions & Content
      const content = data.server_content || data.serverContent;
      if (content) {
        const parts = content.model_turn?.parts || content.modelTurn?.parts;
        if (parts) {
          parts.forEach(p => {
            if (p.text) console.log("--- [AI TEXT] 🧠:", p.text);
            if (p.inline_data || p.inlineData) console.log("--- [AI AUDIO] 🎵: Received Audio Chunk inside JSON");
          });
        }
        const transcript = content.output_transcription?.text || content.outputTranscription?.text;
        if (transcript) console.log("--- [AI TRANSCRIPT] 💬:", transcript);
      }

      // 4. Handle JSON: Errors
      if (data.error) {
        console.error("--- [GOOGLE ERROR] ❌ ---", JSON.stringify(data.error));
      }

      // Relay JSON messages to client
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "None"} ---`);
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE WS ERROR] ---", err);

    clientSocket.onclose = () => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});