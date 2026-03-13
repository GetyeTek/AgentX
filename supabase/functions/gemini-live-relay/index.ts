import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.0-flash-exp";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("--- NEW CLIENT CONNECTION ---");
    
    if (!GEMINI_API_KEY) {
      console.error("ERROR: GEMINI_API_KEY is not set in Supabase Secrets");
      clientSocket.send(JSON.stringify({ 
        error: "RELAY_ERROR", 
        message: "GEMINI_API_KEY missing on server side" 
      }));
      clientSocket.close(4000, "Missing API Key");
      return;
    }

    console.log("Connecting to Google Gemini Live API...");
    const googleSocket = new WebSocket(GOOGLE_WS_URL);

    googleSocket.onopen = () => {
      console.log("SUCCESS: Connected to Google Gemini.");
      
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
      console.log("Sent setup message to Google.");
    };

    googleSocket.onmessage = (event) => {
      console.log("Received from Google: ", event.data.substring(0, 100) + "...");
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    googleSocket.onerror = (err) => {
      console.error("GOOGLE SOCKET ERROR:", err);
      clientSocket.send(JSON.stringify({ error: "GOOGLE_ERROR", detail: err }));
    };

    googleSocket.onclose = (event) => {
      console.log(`Google Socket closed. Code: ${event.code}, Reason: ${event.reason}`);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close(event.code, "Google disconnected: " + event.reason);
      }
    };

    clientSocket.onmessage = (event) => {
      // Only log if it's not a heavy media chunk to avoid spamming logs
      if (typeof event.data === 'string' && !event.data.includes('media_chunks')) {
        console.log("Client sent control message:", event.data);
      }
      
      if (googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(event.data);
      } else {
        console.warn("Warning: Client sent data but Google socket is not open. State:", googleSocket.readyState);
      }
    };

    clientSocket.onclose = () => {
      console.log("Client disconnected from relay.");
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.close();
    };
  };

  return response;
});