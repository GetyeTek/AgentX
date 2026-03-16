import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const API_KEY = Deno.env.get("GEMINI_API_KEY");
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=" + API_KEY;

serve(async (req) => {
  const { image, tree, prompt } = await req.json();

  const payload = {
    contents: [{
      parts: [
        { text: `SYSTEM: You are an autonomous Android co-pilot. \nGoal: ${prompt}\n\nUI TREE ANALYSIS:\n${tree}` },
        { inline_data: { mime_type: "image/jpeg", data: image } },
        { text: "Based on the current screenshot and UI tree, what is the next single action to achieve the goal? If the goal is reached, respond with text starting with 'DONE:'." }
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
    system_instruction: { 
      parts: [{
        text: "You are AgentX. When asked to open an app, follow this ORCHESTRATION PLAN:\n" +
              "1. If not on the Home screen, call 'home'.\n" +
              "2. From Home, open the App Drawer (usually 'swipe' with direction 'up').\n" +
              "3. Browse the App Drawer: Look at the UI Tree for the app name. If not found, 'swipe' to the next page.\n" +
              "4. Once the app icon is visible, use 'tap_node' with the app's name.\n" +
              "RULES:\n" +
              "- Never guess coordinates for an icon if it is in the UI Tree; use tap_node.\n" +
              "- If an action doesn't change the screen, try a different approach (e.g., swipe a different direction).\n" +
              "- Respond with 'DONE: [App Name] opened' only when you see the app's actual interface."
      }]
    }
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  
  // Log to Supabase Console
  console.log("--- GEMINI RAW RESPONSE ---");
  console.log(JSON.stringify(data, null, 2));

  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
});