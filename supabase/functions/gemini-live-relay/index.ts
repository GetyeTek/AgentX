import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// 100ms of 16kHz Mono 16-bit PCM silence (3200 bytes of zeros)
const SILENCE_BASE64 = btoa(String.fromCharCode(...new Uint8Array(3200).fill(0)));

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- [RELAY] CLIENT CONNECTED ---");
    
    if (!GEMINI_API_KEY) {
      console.error("--- [ERROR] GEMINI_API_KEY IS MISSING ---");
      clientSocket.close(4000, "Missing API Key");
      return;
    }

    console.log(`--- [RELAY] Connecting to Google Gemini: ${MODEL} ---`);
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let silenceInterval: number | undefined;

    const cleanup = (source: string) => {
      console.log(`--- [RELAY] Cleaning up session. Triggered by: ${source} ---`);
      if (silenceInterval) {
        clearInterval(silenceInterval);
        console.log("--- [RELAY] Heartbeat stopped ---");
      }
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    googleSocket.onopen = () => {
      console.log("--- [SUCCESS] Google Gemini WebSocket Opened ---");
      
      const setupMessage = {
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: {
            parts: [{ text: "You are a real-time screen observer. Briefly describe the screen snapshots sent to you." }]
          }
        }
      };
      
      console.log("--- [RELAY] Sending Setup Message: ", JSON.stringify(setupMessage));
      googleSocket.send(JSON.stringify(setupMessage));

      console.log("--- [RELAY] Starting 500ms Silent Heartbeat ---");
      silenceInterval = setInterval(() => {
        if (googleSocket.readyState === WebSocket.OPEN) {
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: SILENCE_BASE64
              }]
            }
          }));
        }
      }, 500);
    };

    googleSocket.onmessage = (event) => {
      // Log the response but truncate it if it's massive
      const preview = typeof event.data === 'string' ? event.data.substring(0, 200) : "Binary Data";
      console.log("--- [GOOGLE -> CLIENT]:", preview + "...");
      
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.warn(`--- [GOOGLE CLOSED] Code: ${e.code}, Reason: ${e.reason} ---`);
      cleanup("Google Close Event");
    };

    googleSocket.onerror = (err) => {
      console.error("--- [GOOGLE ERROR] ---", err);
      cleanup("Google Error Event");
    };

    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        // Only log non-binary messages to avoid flooding logs with image base64
        if (typeof event.data === 'string' && event.data.length < 1000) {
           console.log("--- [CLIENT -> GOOGLE] Control Message:", event.data);
        } else {
           console.log(`--- [CLIENT -> GOOGLE] Forwarding Media Chunk (${event.data.length} bytes) ---`);
        }
        googleSocket.send(event.data);
      } else {
        console.warn("--- [RELAY] Client sent data but Google is not connected! ---");
      }
    };

    clientSocket.onclose = () => {
      console.log("--- [CLIENT CLOSED] Client disconnected from relay ---");
      cleanup("Client Close Event");
    };

    clientSocket.onerror = (err) => {
      console.error("--- [CLIENT ERROR] ---", err);
      cleanup("Client Error Event");
    };
  };

  return response;
});