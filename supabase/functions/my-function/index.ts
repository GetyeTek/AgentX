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
    console.log("--- [RELAY] 🟢 STARTING ---");
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
          system_instruction: { parts: [{ text: "You are a helpful AI. Listen to the audio provided and summarize it." }] },
          input_audio_transcription: {},
          output_audio_transcription: {}
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      // Handle Binary vs Text
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        console.log(`--- [GOOGLE] 🔊 Received Binary Data: ${event.data.size || event.data.byteLength} bytes (likely Audio) ---`);
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
        return;
      }

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.log("--- [GOOGLE] 📝 Received non-JSON text frame:", event.data.slice(0, 50));
        return;
      }

      // 1. Setup Complete Logic
      if (data.setup_complete || data.setupComplete) {
        console.log("--- [GOOGLE] ✅ Setup Ready. Streaming Audio... ---");
        
        const { data: fileData } = await supabase.storage.from('Audio').download('audio.pcm');
        if (!fileData) return console.error("PCM Load Fail");

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; 
        let offset = 0;

        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            clearInterval(interval);
            console.log("--- [SHOVEL] 🏁 Stream finished. Triggering AI Response... ---");
            
            // CRITICAL: Send a text turn to "end" the audio and ask for a response
            googleSocket.send(JSON.stringify({
              client_content: {
                turns: [{ role: "user", parts: [{ text: "I have finished sending the audio. Please respond to what you heard." }] }],
                turn_complete: true
              }
            }));
            return;
          }

          const chunk = uint8Array.slice(offset, offset + chunkSize);
          googleSocket.send(JSON.stringify({
            realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64.encode(chunk) }] }
          }));
          offset += chunkSize;
        }, 200);
        return;
      }

      // 2. Transcription & Text Waterfall
      const content = data.server_content || data.serverContent;
      if (content) {
        // Look for model turn text
        const parts = content.model_turn?.parts || content.modelTurn?.parts;
        if (parts) {
          parts.forEach(p => {
            if (p.text) console.log("--- [AI TEXT] 🧠:", p.text);
            if (p.inline_data || p.inlineData) console.log("--- [AI AUDIO] 🎵: Model sent audio chunk in JSON");
          });
        }
        // Look for transcriptions
        const transcript = content.output_transcription?.text || content.outputTranscription?.text;
        if (transcript) console.log("--- [AI TRANSCRIPT] 💬:", transcript);
      }

      // 3. Error Waterfall
      if (data.error) console.error("--- [GOOGLE ERROR] ---", data.error);

      // Relay JSON messages to client
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(event.data);
    };

    googleSocket.onclose = (e) => console.warn(`--- [GOOGLE CLOSED] Code: ${e.code} ---`);
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});