const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

    console.log("--- [STEP 1] Fetching latest image and audio.pcm ---");
    const { data: files } = await supabase.storage.from('Audio').list('', { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
    if (!files || files.length === 0) throw new Error("No images found!");

    // 1. Download Latest Image
    const { data: imgBlob } = await supabase.storage.from('Audio').download(files[0].name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    // 2. Download audio.pcm
    const { data: audioBlob, error: audioErr } = await supabase.storage.from('Audio').download('audio.pcm');
    if (audioErr) console.warn("--- [WARN] audio.pcm not found, proceeding with image only ---");
    const base64Audio = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()).toString('base64') : null;
    
    console.log(`--- [STEP 2] Encoded Image (${base64Image.length}) and Audio (${base64Audio?.length || 0}) ---`);

    const ws = new WebSocket(URL);

    ws.on('open', () => {
        console.log("--- [STEP 3] Connected to Google. Sending Setup... ---");
        ws.send(JSON.stringify({
            setup: {
                model: MODEL,
                generation_config: { response_modalities: ["TEXT"] },
                system_instruction: { parts: [{ text: "You are AgentX. You are a multimodal expert. You will receive an image and an audio file. Describe the image and transcribe the audio perfectly." }] }
            }
        }));
    });

    ws.on('message', (data) => {
        const raw = data.toString();
        console.log("--- [RAW RESPONSE] ---", raw);
        
        const parsed = JSON.parse(raw);
        if (parsed.setupComplete) {
            console.log("--- [STEP 4] Setup Confirmed. Injecting Multi-part Turn... ---");
            
            const parts = [
                { text: "Describe the attached image and transcribe the attached audio clip." },
                { inline_data: { mime_type: "image/jpeg", data: base64Image } }
            ];

            if (base64Audio) {
                parts.push({ inline_data: { mime_type: "audio/pcm;rate=16000", data: base64Audio } });
            }

            ws.send(JSON.stringify({
                client_content: {
                    turns: [{ role: "user", parts: parts }],
                    turn_complete: true
                }
            }));
        }
    });

    ws.on('error', console.error);
    setTimeout(() => { console.log("Test timeout reached."); process.exit(0); }, 15000);
}

runTest().catch(console.error);