import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

serve(async (req) => {
  const { image, tree, prompt } = await req.json();

  // 1. LSF Strategy: Fetch least used active Gemini key
  const { data: keys, error: dbError } = await supabase
    .from('api_keys')
    .select('*')
    .eq('service', 'gemini')
    .eq('is_active', true)
    .or(`cooldown_until.is.null,cooldown_until.lt.${new Date().toISOString()}`)
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .limit(1);

  if (dbError || !keys || keys.length === 0) {
    return new Response(JSON.stringify({ error: "No available Gemini API keys found in database." }), { status: 500 });
  }

  const selectedKey = keys[0];
  const API_KEY = selectedKey.api_key;
  const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${API_KEY}`;

  // 2. Update last_used_at immediately to rotate the key
  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', selectedKey.id);

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
        { name: "open_app", description: "Directly launch an app by name (e.g. 'YouTube', 'Settings', 'Messages')", parameters: { type: "OBJECT", properties: { name: { type: "string" } } } },
        { name: "type_text", description: "Type text into an input field or the currently focused element", parameters: { type: "OBJECT", properties: { query: { type: "string", description: "Text or ID of the input field to target (optional)" }, text: { type: "string", description: "The text to type" } }, required: ["text"] } },
        { name: "swipe", description: "Swipe in a direction", parameters: { type: "OBJECT", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } } } },
        { name: "home", description: "Press Home button", parameters: { type: "OBJECT", properties: {} } },
        { name: "back", description: "Press Back button", parameters: { type: "OBJECT", properties: {} } },
        { name: "recents", description: "Open Recent Apps", parameters: { type: "OBJECT", properties: {} } },
        { name: "wait", description: "Wait for animations to finish or content to load", parameters: { type: "OBJECT", properties: { seconds: { type: "integer" } } } }
      ]
    }],
    system_instruction: { 
      parts: [{
        text: "You are AgentX, an autonomous Android co-pilot. \n" +
              "### OUTPUT RULES:\n" +
              "1. Your response MUST consist of TWO parts: a plain text explanation AND a separate function call.\n" +
              "2. NEVER include JSON strings, code blocks, or tool-use syntax inside the text part. The text part is for the user's eyes only.\n" +
              "3. For any request to open, launch, or start an app, YOU MUST USE 'open_app'. Do not use home/swipe/tap to find apps manually.\n\n" +
              "### ORCHESTRATION PLAN:\n" +
              "- To start a task: Use 'open_app' with the most likely app name.\n" +
              "- To navigate: Use 'tap_node' (preferred) or 'tap_coords' based on the UI tree and screenshot.\n" +
              "- To scroll: Use 'swipe'.\n" +
              "- To finish: Respond with text starting with 'DONE:' and NO function call.\n\n" +
              "### CRITICAL:\n" +
              "If you are stuck (screen not changing), try a different tool or direction. Do not repeat the same failed action more than twice."
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