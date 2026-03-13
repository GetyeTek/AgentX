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
    console.log("--- CLIENT CONNECTED ---");
    
    if (!GEMINI_API_KEY) {
      console.error("ERROR: GEMINI_API_KEY missing");
      clientSocket.close(4000, "Missing API Key");
      return;
    }

    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let silenceInterval: number | undefined;

    const cleanup = () => {
      if (silenceInterval) clearInterval(silenceInterval);
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
      console.log("--- SESSION CLEANED UP ---");
    };

    googleSocket.onopen = () => {
      console.log("SUCCESS: Google Connected");
      
      const setupMessage = {
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["TEXT"] },
          input_metadata: {
            audio_config: { sample_rate: 16000 }
          },
          system_instruction: {
            parts: [{ text: "You are a real-time screen observer. Briefly describe the screen snapshots sent to you." }]
          }
        }
      };
      googleSocket.send(JSON.stringify(setupMessage));

      // Start sending silence every 500ms to keep Google happy
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
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onclose = (e) => {
      console.log(`Google closed: ${e.code}`);
      cleanup();
    };

    googleSocket.onerror = (err) => {
      console.error("Google Socket Error:", err);
      cleanup();
    };

    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(event.data);
      }
    };

    clientSocket.onclose = () => {
      console.log("Client disconnected");
      cleanup();
    };

    clientSocket.onerror = () => cleanup();
  };

  return response;
});