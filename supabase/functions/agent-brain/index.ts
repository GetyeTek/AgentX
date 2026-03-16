import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const API_KEY = Deno.env.get("GEMINI_API_KEY");
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=" + API_KEY;

serve(async (req) => {
  const { image, tree, prompt } = await req.json();

  const payload = {
    contents: [{
      parts: [
        { text: `CONTEXT: You are AgentX. Current UI Tree: ${tree}` },
        { inline_data: { mime_type: "image/jpeg", data: image } },
        { text: prompt }
      ]
    }],
    tools: [{
      function_declarations: [
        { name: "tap_coords", description: "Tap X,Y coordinates (based on 1024 width)", parameters: { type: "OBJECT", properties: { x: { type: "integer" }, y: { type: "integer" } } } },
        { name: "tap_node", description: "Tap a specific element text or ID found in the UI tree", parameters: { type: "OBJECT", properties: { query: { type: "string" } } } },
        { name: "swipe", description: "Swipe in a direction", parameters: { type: "OBJECT", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } } } },
        { name: "home", description: "Press Home button", parameters: { type: "OBJECT", properties: {} } },
        { name: "back", description: "Press Back button", parameters: { type: "OBJECT", properties: {} } },
        { name: "recents", description: "Open Recent Apps", parameters: { type: "OBJECT", properties: {} } },
        { name: "wait", description: "Wait for animations to finish or content to load", parameters: { type: "OBJECT", properties: { seconds: { type: "integer" } } } }
      ]
    }],
    system_instruction: { parts: [{ text: "Analyze the UI tree first. If a clickable node matches the goal, use tap_node. Otherwise, use tap_coords based on image pixels (1024 width scaled)." }] }
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
});