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
    let isSetupComplete = false;
    const messageQueue: any[] = [];

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

      console.log("--- [RELAY] Starting 200ms Silent Heartbeat ---");
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
      }, 200);

      isSetupComplete = true;
      
      // Send an initial text 'ping' to wake up the model
      googleSocket.send(JSON.stringify({
        realtime_input: {
          media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: SILENCE_BASE64 }],
          text: "System start. I am showing you my screen. Please observe."
        }
      }));

      console.log("--- [RELAY] Setup complete, flushing queued messages: ", messageQueue.length);
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        googleSocket.send(msg);
      }
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
      let outboundData = event.data;

      // INTERCEPT AND INJECT SILENCE
      try {
        const payload = JSON.parse(typeof outboundData === 'string' ? outboundData : new TextDecoder().decode(outboundData));
        if (payload.realtime_input?.media_chunks) {
          // Add silence chunk to the SAME array so Google sees audio + image together
          payload.realtime_input.media_chunks.push({
            mime_type: "audio/pcm;rate=16000",
            data: SILENCE_BASE64
          });
          outboundData = JSON.stringify(payload);
        }
      } catch (e) {
        // Not JSON or malformed, just let it pass through
      }

      if (isSetupComplete && googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(outboundData);
      } else if (googleSocket.readyState === WebSocket.CONNECTING || !isSetupComplete) {
        console.log("--- [RELAY] Queuing message until handshake finishes ---");
        messageQueue.push(outboundData);
        if (messageQueue.length > 10) messageQueue.shift();
      } else {
        console.warn("--- [RELAY] Drop message, Google socket state: ", googleSocket.readyState);
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