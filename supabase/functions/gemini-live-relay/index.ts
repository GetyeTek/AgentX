import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 Android App Connected ---");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);

    // 1. INITIAL SETUP (The Golden Config)
    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Pipeline Opened. Initializing Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Puck" }
              }
            }
          },
          system_instruction: {
            parts: [{ text: "You are AgentX, a concise observer. Rules: 1. Only comment if the screen content changes significantly. 2. If nothing is happening, stay silent. 3. Use maximum 10-15 words per response. 4. Do not describe UI elements like 'status bar' unless they change. Focus on the main app content." }]
          },
          input_audio_transcription: {}, 
          output_audio_transcription: {}
        }
      }));
    };

    // 2. GOOGLE -> CLIENT (AI Responses)
    googleSocket.onmessage = async (event) => {
      let textContent = "";
      let isJson = false;

      // Decode binary frames from Google
      if (event.data instanceof Blob) {
        textContent = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        textContent = new TextDecoder().decode(event.data);
      } else {
        textContent = event.data;
      }

      try {
        const data = JSON.parse(textContent);
        isJson = true;

        // Log significant events
        if (data.setup_complete || data.setupComplete) console.log("--- [GOOGLE] ✅ Setup Ready ---");
        
        const content = data.server_content || data.serverContent;
        if (content) {
          const text = content.model_turn?.parts?.[0]?.text || content.output_transcription?.text || content.outputTranscription?.text;
          if (text) console.log("--- [AI RESPONSE] 🧠:", text);
        }

        if (data.error) console.error("--- [GOOGLE ERROR] ❌ ---", JSON.stringify(data.error));
      } catch (_e) {
        isJson = false; // Raw binary audio frame
      }

      if (!isJson) console.log(`--- [RELAY] 🔊 Streaming AI Voice: ${event.data.size || event.data.byteLength} bytes ---`);

      // Forward to Android
      if (clientSocket.readyState === WebSocket.OPEN) {
        // CRITICAL: If it's JSON, send it as a String so Android's text handler triggers.
        // If it's binary audio, send the raw bytes.
        if (isJson) {
          clientSocket.send(textContent);
        } else {
          clientSocket.send(event.data);
        }
      }
    };

    // 3. CLIENT -> GOOGLE (Screen frames and Mic audio)
    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState !== WebSocket.OPEN) return;
      
      try {
        if (typeof event.data === "string") {
           const parsed = JSON.parse(event.data);
           const chunk = parsed.realtime_input?.media_chunks?.[0];
           
           if (chunk?.mime_type === "image/jpeg") {
              const base64Data = chunk.data;
              const fileName = `debug_${Date.now()}.jpg`;
              
              // Fire and forget upload to not block the AI pipe
              (async () => {
                const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
                const { error } = await supabase.storage.from("Audio").upload(fileName, binary, {
                  contentType: 'image/jpeg',
                  upsert: true
                });
                if (error) console.error("--- [STORAGE ERROR] ---", error.message);
                else console.log(`--- [DEBUG] Frame saved: ${fileName} ---`);
              })();
           }
        }
      } catch (_e) { /* Ignore non-JSON or parsing errors */ }

      googleSocket.send(event.data);
    };

    googleSocket.onclose = (e) => {
      console.log(`--- [RELAY] 🔴 Google closed the pipe: ${e.code} ---`);
      clientSocket.close();
    };

    googleSocket.onerror = (e) => console.error("--- [GOOGLE WS ERROR] ---", e);

    clientSocket.onclose = () => {
      console.log("--- [RELAY] ⚪ Android App Disconnected ---");
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});