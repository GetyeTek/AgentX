import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
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
            parts: [{ text: "You are AgentX, a real-time AI assistant with vision and hearing. Describe what you see on the user's screen vividly. Be concise and helpful." }]
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
      
      // Android is already sending JSON strings with Base64 media chunks
      // We just log the activity and pass it through
      try {
        if (typeof event.data === "string") {
           const parsed = JSON.parse(event.data);
           if (parsed.realtime_input) {
              const mime = parsed.realtime_input.media_chunks?.[0]?.mime_type;
              const size = parsed.realtime_input.media_chunks?.[0]?.data?.length;
              console.log(`--- [CLIENT] 📤 Sending ${mime} (${size} base64 chars) ---`);
           }
        }
      } catch (_e) { /* Non-JSON traffic */ }

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