import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// REVERTED: Using your exact original model name
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// 100ms of 16kHz Mono 16-bit PCM silence (3200 bytes)
const SILENCE_BASE64 = btoa(String.fromCharCode(...new Uint8Array(3200).fill(0)));

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 SESSION START ---");
    
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let pulseInterval: number | undefined;
    let isSetupConfirmed = false;

    const cleanup = (source: string) => {
      console.log(`--- [RELAY] 🧹 Cleaning up. Source: ${source} ---`);
      if (pulseInterval) clearInterval(pulseInterval);
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    // Constant background pulse (100ms audio every 100ms)
    // This keeps the "Voice Extractor" locked in so it doesn't 1007
    const startPulse = () => {
      pulseInterval = setInterval(() => {
        if (googleSocket.readyState === WebSocket.OPEN && isSetupConfirmed) {
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: SILENCE_BASE64
              }]
            }
          }));
        }
      }, 100);
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Connected. Sending Setup... ---");
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: {
            parts: [{ text: "You are a real-time screen observer. Briefly describe snapshots." }]
          }
        }
      }));
    };

    googleSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Confirmed. Starting Audio Pulse... ---");
        isSetupConfirmed = true;
        startPulse();
        return;
      }

      // Log AI's response to the console
      const thought = data.server_content?.model_turn?.parts?.[0]?.text;
      if (thought) console.log("--- [AI] 🧠:", thought);

      // Pass all responses back to the Android app
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    clientSocket.onmessage = (event) => {
      // Ensure we don't send data before setup is ready
      if (!isSetupConfirmed || googleSocket.readyState !== WebSocket.OPEN) return;

      try {
        const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        const payload = JSON.parse(rawData);

        if (payload.realtime_input?.media_chunks) {
          // CRITICAL FIX: 
          // 1. unshift puts silence at Index 0.
          // 2. This ensures the frame Google receives IS an audio request.
          payload.realtime_input.media_chunks.unshift({
            mime_type: "audio/pcm;rate=16000",
            data: SILENCE_BASE64
          });

          // Prevent "empty text" conflict
          delete payload.realtime_input.text;

          googleSocket.send(JSON.stringify(payload));
          console.log("--- [RELAY] 📤 Forwarded Image + Audio Chunk ---");
        }
      } catch (e) {
        console.error("--- [RELAY ERROR] ❌ ---", e.message);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] 🚫 Code: ${e.code}, Reason: ${e.reason} ---`);
      cleanup("Google Closed Connection");
    };

    googleSocket.onerror = (err) => console.error("--- [GOOGLE ERROR] ---", err);
    clientSocket.onclose = () => cleanup("App Disconnected");
  };

  return response;
});