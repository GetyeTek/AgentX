const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

    console.log("--- [STEP 1] Fetching latest image from Supabase Storage ---");
    const { data: files } = await supabase.storage.from('Audio').list('', { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
    
    if (!files || files.length === 0) throw new Error("No images found in bucket!");
    
    const { data: blob } = await supabase.storage.from('Audio').download(files[0].name);
    const arrayBuffer = await blob.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString('base64');
    
    console.log(`--- [STEP 2] Image encoded: ${base64Image.length} characters ---`);

    const ws = new WebSocket(URL);

    ws.on('open', () => {
        console.log("--- [STEP 3] Connected to Google. Sending Setup... ---");
        ws.send(JSON.stringify({
            setup: {
                model: MODEL,
                generation_config: { response_modalities: ["AUDIO"] },
                system_instruction: { parts: [{ text: "You are AgentX. Describe the image provided in detail. Prove you can see the screen." }] }
            }
        }));
    });

    ws.on('message', (data) => {
        const raw = data.toString();
        console.log("--- [RAW RESPONSE] ---", raw);
        
        const parsed = JSON.parse(raw);
        if (parsed.setupComplete) {
            console.log("--- [STEP 4] Setup Confirmed. Injecting Media... ---");
            ws.send(JSON.stringify({
                realtime_input: { media_chunks: [{ mime_type: "image/jpeg", data: base64Image }] }
            }));
            ws.send(JSON.stringify({
                client_content: {
                    turns: [{ role: "user", parts: [{ text: "Look at the screen and describe it now." }] }],
                    turn_complete: true
                }
            }));
        }
    });

    ws.on('error', console.error);
    setTimeout(() => { console.log("Test timeout reached."); process.exit(0); }, 15000);
}

runTest().catch(console.error);