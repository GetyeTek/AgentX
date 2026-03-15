import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Note: Ensure this model string matches the latest documentation
const MODEL = "models/gemini-2.0-flash-exp"; // Suggested stable-ish preview
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    const googleSocket = new WebSocket(GOOGLE_WS_URL);

    googleSocket.onopen = () => {
      // 1. Send Setup Message (FIXED CASING)
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { 
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } 
            }
          },
          systemInstruction: { 
            parts: [{ text: "You are AgentX. Observe the visual input and speak only when necessary." }] 
          }
        }
      }));
    };

    // Forward Google -> Client (Handles both Text/JSON and Binary Audio)
    googleSocket.onmessage = (event) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    // Forward Client -> Google (Handles Audio chunks and Vision frames)
    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) {
        googleSocket.send(event.data);
      }
    };

    googleSocket.onerror = (e) => console.error("Google Socket Error:", e);
    googleSocket.onclose = () => clientSocket.close();
    clientSocket.onclose = () => googleSocket.close();
  };

  return response;
});