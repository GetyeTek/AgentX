import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// 200ms of 16kHz Mono 16-bit PCM silence
const SILENCE_BASE64 = btoa(String.fromCharCode(...new Uint8Array(6400).fill(0)));

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] CLIENT CONNECTED ---");
    
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let silenceInterval: number | undefined;
    let isSetupConfirmed = false;
    let lastSendTimestamp = 0; // Track timing to prevent collisions

    const cleanup = (source: string) => {
      console.log(`--- [RELAY] Cleaning up. Source: ${source} ---`);
      if (silenceInterval) clearInterval(silenceInterval);
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    // Robust Heartbeat: Only sends if we haven't sent media recently
    const sendHeartbeat = () => {
      const now = Date.now();
      if (isSetupConfirmed && googleSocket.readyState === WebSocket.OPEN) {
        // If we sent an image in the last 150ms, skip this heartbeat 
        // to prevent overlapping messages
        if (now - lastSendTimestamp < 150) return;

        googleSocket.send(JSON.stringify({
          realtime_input: {
            media_chunks: [{
              mime_type: "audio/pcm;rate=16000",
              data: SILENCE_BASE64
            }]
          }
        }));
        lastSendTimestamp = now;
      }
    };

    googleSocket.onopen = () => {
      console.log("--- [SUCCESS] Google Connected ---");
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
        console.log("--- [RELAY] Setup Confirmed ---");
        isSetupConfirmed = true;
        silenceInterval = setInterval(sendHeartbeat, 200);
        return;
      }

      // Log model thoughts
      if (data.server_content?.model_turn) {
        console.log("--- [AI]:", JSON.stringify(data.server_content.model_turn.parts[0].text));
      }

      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    clientSocket.onmessage = async (event) => {
      if (!isSetupConfirmed || googleSocket.readyState !== WebSocket.OPEN) return;

      try {
        const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        const payload = JSON.parse(rawData);

        if (payload.realtime_input?.media_chunks) {
          // FIX 1: Audio MUST be first in the array for the voice extractor
          payload.realtime_input.media_chunks.unshift({
            mime_type: "audio/pcm;rate=16000",
            data: SILENCE_BASE64
          });

          // FIX 2: Explicitly ensure there is no empty text field that confuses the model
          delete payload.realtime_input.text; 

          const finalPayload = JSON.stringify(payload);
          googleSocket.send(finalPayload);
          lastSendTimestamp = Date.now();
        }
      } catch (e) {
        console.error("--- [RELAY ERROR] ---", e.message);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] ${e.code}: ${e.reason} ---`);
      cleanup("Google Close");
    };

    googleSocket.onerror = (e) => console.error("Google Error", e);
    clientSocket.onclose = () => cleanup("Client Close");
  };

  return response;
});