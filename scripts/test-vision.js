const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

    console.log("--- [STEP 1] Fetching target files ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    
    const imageFile = files
        .filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!imageFile) throw new Error("No JPEG images found in bucket!");
    console.log(`--- [INFO] Using Image: ${imageFile.name} ---`);

    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob, error: audioErr } = await supabase.storage.from('Audio').download('audio.pcm');
    let base64Audio = null;
    if (audioErr) {
        console.warn("--- [WARN] audio.pcm missing ---");
    } else {
        base64Audio = Buffer.from(await audioBlob.arrayBuffer()).toString('base64');
    }
    
    console.log(`--- [STEP 2] Image (${base64Image.length}) | Audio (${base64Audio?.length || 0}) ---`);

    const ws = new WebSocket(URL);

    ws.on('open', () => {
        console.log("--- [STEP 3] WebSocket Connected. Sending Setup... ---");
        ws.send(JSON.stringify({
            setup: {
                model: MODEL,
                generation_config: { 
                    response_modalities: ["AUDIO"],
                    speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
                },
                input_audio_transcription: {},
                system_instruction: { parts: [{ text: "You are AgentX. Describe the image and transcribe the audio accurately." }] }
            }
        }));
    });

    ws.on('message', (data) => {
        const raw = data.toString();
        try {
            const parsed = JSON.parse(raw);
            console.log("--- [INCOMING] ---", JSON.stringify(parsed, (k,v) => k === 'data' ? '[BINARY]' : v, 2));

            if (parsed.setupComplete || parsed.setup_complete) {
                console.log("--- [STEP 4] Setup Confirmed. Sending Hybrid Payload... ---");
                
                if (base64Audio) {
                    ws.send(JSON.stringify({
                        realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: base64Audio }] }
                    }));
                }

                ws.send(JSON.stringify({
                    client_content: {
                        turns: [{
                            role: "user",
                            parts: [
                                { text: "Transcribe the audio I just sent and describe this image." },
                                { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                            ]
                        }],
                        turn_complete: true
                    }
                }));
                console.log("--- [STEP 5] All data sent. Waiting... ---");
            }

            if (parsed.serverContent?.modelTurn || parsed.serverContent?.outputTranscription) {
                console.log("--- [SUCCESS] Received Content! ---");
                // Keep alive for 2 more seconds to catch remaining frames
                setTimeout(() => process.exit(0), 2000);
            }

            if (parsed.error) {
                console.error("--- [ERROR] ---", JSON.stringify(parsed.error, null, 2));
                process.exit(1);
            }
        } catch (e) {
            console.log("--- [RAW] ---", raw.substring(0, 100));
        }
    });

    ws.on('error', (err) => { console.error("--- [WS ERROR] ---", err); process.exit(1); });
    ws.on('close', (c, r) => { console.log(`--- [WS CLOSED] ${c}: ${r} ---`); });
    
    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(1); }, 30000);
}

runTest().catch(console.error);