import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Keep your specific model version
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// 200ms of 16kHz Mono 16-bit PCM silence (6400 bytes)
// We use 200ms to provide a larger buffer for Google's voice extractor
const SILENCE_BASE64 = btoa(String.fromCharCode(...new Uint8Array(6400).fill(0)));

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
    let isSetupConfirmed = false; 
    const messageQueue: any[] = [];

    const cleanup = (source: string) => {
      console.log(`--- [RELAY] Cleaning up session. Triggered by: ${source} ---`);
      if (silenceInterval) clearInterval(silenceInterval);
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    // Helper to send a silence chunk
    const sendSilenceHeartbeat = () => {
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
    };

    googleSocket.onopen = () => {
      console.log("--- [SUCCESS] Google Gemini WebSocket Opened ---");
      
      // STEP 1: Send Setup
      const setupMessage = {
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: {
            parts: [{ text: "You are a real-time screen observer. Briefly describe the screen snapshots sent to you." }]
          }
        }
      };
      
      console.log("--- [RELAY] Sending Setup Message ---");
      googleSocket.send(JSON.stringify(setupMessage));
    };

    googleSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // STEP 2: Wait for Setup Confirmation before doing ANYTHING else
      if (data.setup_complete) {
        console.log("--- [RELAY] Google Setup Confirmed. Starting Heartbeat ---");
        isSetupConfirmed = true;

        // Start 200ms heartbeat (matching our 200ms audio chunk)
        silenceInterval = setInterval(sendSilenceHeartbeat, 200);

        // Flush any queued images that arrived during handshake
        console.log("--- [RELAY] Flushing queued messages: ", messageQueue.length);
        while (messageQueue.length > 0) {
          googleSocket.send(messageQueue.shift());
        }
        return;
      }

      // Relay all other messages (model thoughts) to the Android app
      const preview = typeof event.data === 'string' ? event.data.substring(0, 150) : "Binary Data";
      console.log("--- [GOOGLE -> CLIENT]:", preview + "...");
      
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    clientSocket.onmessage = (event) => {
      let outboundData = event.data;

      try {
        const payload = JSON.parse(typeof outboundData === 'string' ? outboundData : new TextDecoder().decode(outboundData));
        
        // STEP 3: Inject silence into the SAME message as the image
        // This ensures Google's "Voice Extractor" has audio context for this specific request
        if (payload.realtime_input?.media_chunks) {
          payload.realtime_input.media_chunks.push({
            mime_type: "audio/pcm;rate=16000",
            data: SILENCE_BASE64
          });
          outboundData = JSON.stringify(payload);
        }
      } catch (e) {
        // Not JSON media, leave it as is
      }

      // Only send if setup is done; otherwise queue it
      if (isSetupConfirmed && googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(outboundData);
      } else {
        console.log("--- [RELAY] Handshake in progress, queuing message ---");
        messageQueue.push(outboundData);
        if (messageQueue.length > 5) messageQueue.shift(); // Don't let queue explode
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

    clientSocket.onclose = () => {
      console.log("--- [CLIENT CLOSED] ---");
      cleanup("Client Close Event");
    };

    clientSocket.onerror = (err) => {
      console.error("--- [CLIENT ERROR] ---", err);
      cleanup("Client Error Event");
    };
  };

  return response;
});