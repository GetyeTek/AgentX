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
    console.log("--- [RELAY] 🟢 STARTING RESILIENT SHOVEL ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let setupConfirmed = false;
    const setupTimeout = setTimeout(() => {
      if (!setupConfirmed) console.error("--- [CRITICAL] ⏳ HANG DETECTED: No setup response from Google. ---");
    }, 15000);

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Sending Comprehensive Setup... ---");
      
      // We use the structure that most closely aligns with the successful "setupComplete" response
      const setupMsg = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: "Puck"
                }
              }
            }
          },
          // Waterfall: Some versions want these, some don't. Including empty objects is safest.
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      };

      googleSocket.send(JSON.stringify(setupMsg));
    };

    googleSocket.onmessage = async (event) => {
      let rawData = event.data;

      // Polyfill: Handle Blobs, ArrayBuffers, and Strings
      if (rawData instanceof Blob) {
        rawData = await rawData.text();
      } else if (rawData instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(rawData);
      }

      let data;
      try {
        data = JSON.parse(rawData);
      } catch (e) {
        console.error("--- [ERROR] Parse Fail. Data starts with:", String(rawData).slice(0, 50));
        return;
      }

      // --- WATERFALL LOGIC FOR SETUP CONFIRMATION ---
      // Your logs showed "setupComplete". We check for both snake and camel case.
      const isSetupReady = data.setup_complete || data.setupComplete;

      if (isSetupReady && !setupConfirmed) {
        setupConfirmed = true;
        clearTimeout(setupTimeout);
        console.log("--- [GOOGLE] ✅ Setup Ready (Detected via Waterfall). Fetching Storage... ---");
        
        const { data: fileData, error } = await supabase.storage.from('Audio').download('audio.pcm');
        if (error || !fileData) return console.error("--- [STORAGE ERROR] ---", error);

        const uint8Array = new Uint8Array(await fileData.arrayBuffer());
        const chunkSize = 6400; // 200ms

        console.log(`--- [SHOVEL] 📦 Streaming ${uint8Array.length} bytes ---`);

        let offset = 0;
        const interval = setInterval(() => {
          if (googleSocket.readyState !== WebSocket.OPEN || offset >= uint8Array.length) {
            clearInterval(interval);
            console.log("--- [SHOVEL] 🏁 Stream finished ---");
            return;
          }

          const chunk = uint8Array.slice(offset, offset + chunkSize);
          
          // Waterfall: Send binary if preferred, but JSON-wrapped Base64 is the documented standard
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: base64.encode(chunk)
              }]
            }
          }));

          offset += chunkSize;
        }, 200); 
        return;
      }

      // --- WATERFALL LOGIC FOR TRANSCRIPTIONS ---
      // AI sometimes returns data in server_content or serverContent
      const content = data.server_content || data.serverContent;
      if (content) {
        const text = 
          content.model_turn?.parts?.[0]?.text || 
          content.output_transcription?.text || 
          content.outputTranscription?.text;
        
        if (text) console.log("--- [AI TEXT] 🧠:", text);
      }

      // --- WATERFALL LOGIC FOR ERRORS ---
      if (data.error) {
        console.error("--- [GOOGLE API ERROR] ❌ ---", JSON.stringify(data.error));
      }

      // Relay back to client
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      clearTimeout(setupTimeout);
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason || "No Reason"} ---`);
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE WS ERROR] ---", err);

    clientSocket.onclose = () => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});