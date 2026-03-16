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
              text: "You are AgentX, an Android co-pilot. RULES:\n1. IMMEDIATE ACTION: When you decide to tap or swipe, emit the tool call IMMEDIATELY. Do not describe the plan first.\n2. COORDINATES: The image is 1024px wide. Calculate Y based on aspect ratio. Send coordinates relative to 1024px width.\n3. FEEDBACK: A red dot appears where you last tapped. Use it to self-correct.\n4. HUD: Wrap speech in triple backticks. Keep HUD messages extremely short (e.g., ```Tapping Settings...```). No backticks = Silence."
            }]
          },
          tools: [{
            function_declarations: [
              { name: "tap", description: "Tap screen at pixel coordinates", parameters: { type: "OBJECT", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
              { name: "home", description: "Press the home button", parameters: { type: "OBJECT", properties: {} } },
              { name: "back", description: "Press the back button", parameters: { type: "OBJECT", properties: {} } },
              { name: "recents", description: "Open recent apps list", parameters: { type: "OBJECT", properties: {} } },
              { 
                name: "swipe", 
                description: "Swipe from one point to another", 
                parameters: { 
                  type: "OBJECT", 
                  properties: { 
                    x1: { type: "integer", description: "Start X" }, 
                    y1: { type: "integer", description: "Start Y" },
                    x2: { type: "integer", description: "End X" },
                    y2: { type: "integer", description: "End Y" }
                  }, 
                  required: ["x1", "y1", "x2", "y2"] 
                } 
              }
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