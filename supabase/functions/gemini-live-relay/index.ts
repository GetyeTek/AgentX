import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return new Response("Not a websocket", { status: 426 });

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  clientSocket.onopen = () => {
    const googleSocket = new WebSocket(GOOGLE_WS_URL);
    let transcriptionBuffer = "";

    clientSocket.onmessage = (event) => {
      if (googleSocket.readyState === WebSocket.OPEN) googleSocket.send(event.data);
    };

    googleSocket.onopen = () => {
      googleSocket.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: { response_modalities: ["AUDIO"] },
          system_instruction: {
            parts: [{
              text: "You are AgentX, an AI co-pilot for a Samsung Galaxy A31. The screen resolution is exactly 1080x2400 pixels. Use the provided tools to interact with the device based on what you see in the screenshots. Rules: 1. To click an icon, estimate its pixel coordinates (x from 0-1080, y from 0-2400). 2. Be precise. 3. Wrap verbal speech in triple backticks. 4. If a user command requires multiple steps, do them one by one."
            }]
          },
          tools: [{
            function_declarations: [
              { name: "tap", description: "Tap screen at pixel coordinates", parameters: { type: "OBJECT", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
              { name: "home", description: "Press the home button", parameters: { type: "OBJECT", properties: {} } },
              { name: "back", description: "Press the back button", parameters: { type: "OBJECT", properties: {} } },
              { name: "recents", description: "Open recent apps list", parameters: { type: "OBJECT", properties: {} } }
            ]
          }],
          output_audio_transcription: {},
          context_window_compression: { sliding_window: { target_tokens: 15000 } }
        }
      }));
    };

    googleSocket.onmessage = async (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        clientSocket.send(event.data);
        return;
      }

      try {
        const data = JSON.parse(event.data);
        const serverContent = data.server_content || data.serverContent;

        // Buffer text logic stays to keep HUD clean
        const transcript = serverContent?.output_transcription?.text || serverContent?.outputTranscription?.text;
        if (transcript !== undefined) {
          transcriptionBuffer += transcript;
          if (transcriptionBuffer.includes("```")) {
            const parts = transcriptionBuffer.split("```");
            if (parts.length >= 3) {
              const sentence = parts[1].trim();
              if (sentence) clientSocket.send(JSON.stringify({ server_content: { model_turn: { parts: [{ text: sentence }] } } }));
              transcriptionBuffer = parts.slice(2).join("```");
            }
          }
          return;
        }

        // Forward everything else, INCLUDING TOOL CALLS
        clientSocket.send(event.data);
      } catch (e) { clientSocket.send(event.data); }
    };

    googleSocket.onclose = () => clientSocket.close();
    clientSocket.onclose = () => googleSocket.close();
  };
  return response;
});