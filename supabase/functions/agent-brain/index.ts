import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

serve(async (req) => {
  try {
    const { image, tree, prompt } = await req.json();

    // 0. Fetch Knowledge Base: Get all available macro titles
    const { data: macroList } = await supabase.from('task_macros').select('intent_description');
    const availableShortcuts = macroList?.map(m => m.intent_description).join(', ') || 'None';

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
    await supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', selectedKey.id);

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
          { name: "open_app", description: "Directly launch an app by Android package name (e.g. 'com.android.settings') or common name. Package names are preferred.", parameters: { type: "OBJECT", properties: { name: { type: "string", description: "The package name or display name of the app" } } } },
          { name: "type_text", description: "Type text into an input field or the currently focused element", parameters: { type: "OBJECT", properties: { query: { type: "string", description: "Text or ID of the input field to target (optional)" }, text: { type: "string", description: "The text to type" } }, required: ["text"] } },
          { name: "swipe", description: "Swipe in a direction", parameters: { type: "OBJECT", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } } } },
          { name: "home", description: "Press Home button", parameters: { type: "OBJECT", properties: {} } },
          { name: "back", description: "Press Back button", parameters: { type: "OBJECT", properties: {} } },
          { name: "recents", description: "Open Recent Apps", parameters: { type: "OBJECT", properties: {} } },
          { name: "wait", description: "Wait for animations to finish or content to load", parameters: { type: "OBJECT", properties: { seconds: { type: "integer" } } } },
          { name: "save_macro", description: "Save a successful sequence of actions as a shortcut for the future. ONLY save if the path was efficient and robust.", parameters: { type: "OBJECT", properties: { intent: { type: "string", description: "Short description of the task (e.g. 'DM on Telegram')" }, steps: { type: "array", items: { type: "object" }, description: "The sequence of tool calls used" } }, required: ["intent", "steps"] } },
          { name: "search_app_directory", description: "Search the phone's installed apps directory to find the correct package name.", parameters: { type: "OBJECT", properties: { query: { type: "string", description: "The name of the app to search for" } }, required: ["query"] } },
          { name: "get_macro_details", description: "Retrieve the exact sequence of steps for a learned shortcut.", parameters: { type: "OBJECT", properties: { intent: { type: "string", description: "The exact intent_description of the shortcut" } }, required: ["intent"] } }
        ]
      }],
      system_instruction: {
        parts: [{
          text: "You are AgentX, an autonomous Android co-pilot. \n" +
                "### LEARNED SHORTCUTS:\n" + availableShortcuts + "\n\n" +
                "### OUTPUT RULES:\n" +
                "1. Your response MUST consist of TWO parts: a plain text explanation AND a separate function call.\n" +
                "2. NEVER include JSON strings, code blocks, or tool-use syntax inside the text part. The text part is for the user's eyes only.\n" +
                "3. For any request to open, launch, or start an app, YOU MUST USE 'open_app'. Use the Android Package Name if you know it.\n\n" +
                "### ORCHESTRATION PLAN:\n" +
                "- If the user's request matches a LEARNED SHORTCUT, use 'get_macro_details' to see the steps, refine them, and execute.\n" +
                "- To start a task: Use 'open_app'.\n" +
                "- To navigate: Use 'tap_node' (preferred) or 'tap_coords'.\n" +
                "- To scroll: Use 'swipe'.\n" +
                "- To finish: Respond with text starting with 'DONE:' and NO function call.\n\n" +
                "### CRITICAL:\n" +
                "If you are stuck (screen not changing), try a different tool or direction. Do not repeat the same failed action more than twice.\n" +
                "- LEARN: If you successfully complete a multi-step task efficiently, call 'save_macro' so you can do it instantly next time."
        }]
      }
    };

    const performGeminiCall = async (currentPayload: any) => {
      const res = await fetch(ENDPOINT, { method: "POST", body: JSON.stringify(currentPayload) });
      return await res.json();
    };

    let data = await performGeminiCall(payload);

    const getFunctionCall = (d: any) => d.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall)?.functionCall;
    
    // HANDLE CONSULTATIVE TOOLS (search_app_directory or get_macro_details)
    let activeCall = getFunctionCall(data);
    if (activeCall && (activeCall.name === "search_app_directory" || activeCall.name === "get_macro_details")) {
      let toolResponse = {};
      
      if (activeCall.name === "search_app_directory") {
        const { data: apps } = await supabase.from('installed_apps').select('app_name, package_name').ilike('app_name', `%${activeCall.args.query}%`);
        toolResponse = { results: apps };
      } else if (activeCall.name === "get_macro_details") {
        const { data: macro } = await supabase.from('task_macros').select('steps').eq('intent_description', activeCall.args.intent).maybeSingle();
        toolResponse = { steps: macro?.steps || [] };
      }

      const secondPayload = {
        ...payload,
        contents: [
          ...payload.contents,
          data.candidates[0].content,
          { role: "function", parts: [{ functionResponse: { name: activeCall.name, response: toolResponse } }] }
        ]
      };
      
      data = await performGeminiCall(secondPayload);
      activeCall = getFunctionCall(data);
    }

    // Handle save_macro tool call persistence
    if (activeCall && activeCall.name === "save_macro") {
      console.log("--- SAVING NEW MACRO ---");
      await supabase.from('task_macros').insert({ intent_description: activeCall.args.intent, steps: activeCall.args.steps });
    }

    console.log("--- GEMINI RAW RESPONSE ---");
    console.log(JSON.stringify(data, null, 2));

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});