// @ts-ignore: Deno types
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.0-flash-exp"; 
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    return new Response("This endpoint requires a WebSocket connection.", { status: 426 });
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    console.log("App connected to relay. Connecting to Gemini...");
    
    // Connect to Google Gemini
    const googleSocket = new WebSocket(GOOGLE_WS_URL);

    googleSocket.onopen = () => {
      console.log("Connected to Google Gemini Live API.");
      
      // Send the Initial Setup Message to Gemini
      const setupMessage = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["TEXT"], // We only want text thoughts for the overlay
          },
          system_instruction: {
            parts: [{ 
              text: "You are a real-time screen observer. I will send you images of my screen. Briefly describe what you see or provide helpful context about the current UI. Keep answers short for a screen overlay." 
            }]
          }
        }
      };
      googleSocket.send(JSON.stringify(setupMessage));
    };

    // Forward Gemini's thoughts back to the App
    googleSocket.onmessage = (event) => {
      clientSocket.send(event.data);
    };

    // Forward Screen Frames from App to Gemini
    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        // App will send JSON: { "realtime_input": { "media_chunks": [{ "data": "BASE64_IMAGE", "mime_type": "image/jpeg" }] } }
        googleSocket.send(event.data);
      }
    };

    googleSocket.onclose = () => clientSocket.close();
    googleSocket.onerror = (err) => console.error("Gemini Socket Error:", err);
    
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});