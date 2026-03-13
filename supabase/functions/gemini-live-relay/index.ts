import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// 100ms of 16kHz Mono 16-bit PCM silence (3200 bytes)
// Smaller chunks are "easier" for Google's voice extractor to digest
const SILENCE_BASE64 = btoa(String.fromCharCode(...new Uint8Array(3200).fill(0)));

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] 🟢 CLIENT CONNECTED ---");
    
    if (!GEMINI_API_KEY) {
      console.error("--- [ERROR] 🔴 GEMINI_API_KEY IS MISSING ---");
      clientSocket.close(4000, "Missing API Key");
      return;
    }

    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let silenceInterval: number | undefined;
    let isSetupConfirmed = false;
    let lastMediaTime = 0; 

    const cleanup = (source: string) => {
      console.log(`--- [RELAY] 🧹 Cleaning up. Source: ${source} ---`);
      if (silenceInterval) clearInterval(silenceInterval);
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    // This ensures there is NEVER "dead air" on the connection
    const sendPulse = () => {
      const now = Date.now();
      // Only send a standalone silence pulse if we haven't sent media in the last 150ms
      if (isSetupConfirmed && googleSocket.readyState === WebSocket.OPEN && (now - lastMediaTime > 150)) {
        googleSocket.send(JSON.stringify({
          realtime_input: {
            media_chunks: [{
              mime_type: "audio/pcm;rate=16000",
              data: SILENCE_BASE64
            }]
          }
        }));
      }
    };

    googleSocket.onopen = () => {
      console.log("--- [GOOGLE] 🔵 Socket Opened. Sending Setup... ---");
      const setupMessage = {
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: {
            parts: [{ text: "You are a real-time screen observer. Briefly describe the screen snapshots sent to you." }]
          }
        }
      };
      googleSocket.send(JSON.stringify(setupMessage));
    };

    googleSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // CRITICAL: Google logic says wait for setup_complete
      if (data.setup_complete) {
        console.log("--- [GOOGLE] ✅ Setup Confirmed! Starting Audio Pulse ---");
        isSetupConfirmed = true;
        // Run a pulse every 200ms to keep the "Voice Extractor" warm
        silenceInterval = setInterval(sendPulse, 200);
        return;
      }

      // Log model thoughts to Supabase console for debugging
      if (data.server_content?.model_turn?.parts?.[0]?.text) {
        console.log("--- [AI THOUGHT] 🧠:", data.server_content.model_turn.parts[0].text);
      }

      // Relay everything else back to Android
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    clientSocket.onmessage = (event) => {
      // If we aren't ready, just drop the frames to prevent 1007/1008 errors
      if (!isSetupConfirmed || googleSocket.readyState !== WebSocket.OPEN) {
        console.log("--- [RELAY] ⚠️ Dropping message: Setup not complete ---");
        return;
      }

      try {
        const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        const payload = JSON.parse(rawData);

        if (payload.realtime_input?.media_chunks) {
          console.log(`--- [APP -> GOOGLE] 📤 Sending Image (${payload.realtime_input.media_chunks[0].data.length} bytes) ---`);
          
          // THE "GOOGLE FIX": Audio MUST be present in the message and MUST be first
          payload.realtime_input.media_chunks.unshift({
            mime_type: "audio/pcm;rate=16000",
            data: SILENCE_BASE64
          });

          googleSocket.send(JSON.stringify(payload));
          lastMediaTime = Date.now();
        }
      } catch (e) {
        console.error("--- [RELAY ERROR] 🔴 ---", e.message);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE] 🚫 CLOSED Code: ${e.code}, Reason: ${e.reason} ---`);
      cleanup("Google Socket Closed");
    };

    googleSocket.onerror = (err) => {
      console.error("--- [GOOGLE] ❌ ERROR ---", err);
      cleanup("Google Socket Error");
    };

    clientSocket.onclose = () => cleanup("Client Disconnected");
  };

  return response;
});