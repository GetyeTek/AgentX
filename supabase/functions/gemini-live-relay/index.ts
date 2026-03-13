import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// 100ms of 16kHz Mono 16-bit PCM silence (3200 bytes)
// Smaller chunks are better for the "Voice Extractor" stability
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

    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let heartbeatTimeout: number | undefined;
    let isSetupConfirmed = false;
    const messageQueue: any[] = [];

    const cleanup = (source: string) => {
      console.log(`--- [RELAY] Cleaning up session. Source: ${source} ---`);
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };

    // SELF-RESETTING HEARTBEAT
    // This maintains the "Pulse" Google needs, but resets whenever we send a manual frame
    const scheduleHeartbeat = () => {
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = setTimeout(() => {
        if (googleSocket.readyState === WebSocket.OPEN && isSetupConfirmed) {
          googleSocket.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: SILENCE_BASE64
              }]
            }
          }));
          // Loop the heartbeat
          scheduleHeartbeat();
        }
      }, 100); // 100ms interval for tight sync
    };

    googleSocket.onopen = () => {
      console.log("--- [SUCCESS] Google Gemini WebSocket Opened ---");
      const setupMessage = {
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          system_instruction: {
            parts: [{ text: "You are a real-time screen observer. Briefly describe the screen snapshots sent to you. Focus on UI elements and text." }]
          }
        }
      };
      console.log("--- [RELAY] Sending Setup Message ---");
      googleSocket.send(JSON.stringify(setupMessage));
    };

    googleSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // WAIT FOR SETUP COMPLETE
      if (data.setup_complete) {
        console.log("--- [RELAY] Google Setup Confirmed. Starting Heartbeat ---");
        isSetupConfirmed = true;
        scheduleHeartbeat();

        console.log("--- [RELAY] Flushing queued messages: ", messageQueue.length);
        while (messageQueue.length > 0) {
          googleSocket.send(messageQueue.shift());
        }
        return;
      }

      // Relay model thoughts to the Android app
      if (data.server_content?.model_turn) {
        const thought = data.server_content.model_turn.parts?.[0]?.text;
        if (thought) console.log("--- [AI THOUGHT]:", thought);
      }

      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    clientSocket.onmessage = (event) => {
      let outboundData = event.data;

      try {
        const payload = JSON.parse(typeof outboundData === 'string' ? outboundData : new TextDecoder().decode(outboundData));
        
        if (payload.realtime_input?.media_chunks) {
          // RULE 1: Audio MUST be at the FRONT (Index 0) of the array
          // This "tapes" audio to your image so Google never sees a "non-audio request"
          payload.realtime_input.media_chunks.unshift({
            mime_type: "audio/pcm;rate=16000",
            data: SILENCE_BASE64
          });
          
          // Clean up any empty fields that confuse the Live API
          if (payload.realtime_input.text === "") delete payload.realtime_input.text;

          outboundData = JSON.stringify(payload);
          
          // RULE 2: Reset the heartbeat timer! 
          // We just sent audio with the image, so we don't need a heartbeat for another 100ms.
          // This prevents two messages from hitting Google at the exact same millisecond.
          if (isSetupConfirmed) scheduleHeartbeat();
        }
      } catch (e) {
        // Handle non-JSON or malformed messages
      }

      if (isSetupConfirmed && googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(outboundData);
      } else {
        console.log("--- [RELAY] Handshake in progress, queuing message ---");
        messageQueue.push(outboundData);
        if (messageQueue.length > 5) messageQueue.shift();
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

    clientSocket.onclose = () => cleanup("Client Close Event");
    clientSocket.onerror = (err) => cleanup("Client Error Event");
  };

  return response;
});