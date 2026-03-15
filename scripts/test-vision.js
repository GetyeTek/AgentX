const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

    console.log("--- [STEP 1] Fetching target files from Supabase ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    
    const imageFile = files
        .filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!imageFile) throw new Error("No JPEG images found in bucket!");
    
    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob, error: audioErr } = await supabase.storage.from('Audio').download('audio.pcm');
    let base64Audio = null;
    
    if (audioErr) {
        console.warn("--- [WARN] audio.pcm missing ---");
    } else {
        const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
        
        // SANITY CHECK: WAV vs RAW PCM
        const header = audioBuffer.slice(0, 4).toString('ascii');
        if (header === 'RIFF' || header === 'WAVE') {
            console.error("!!! FATAL ERROR: audio.pcm IS A WAV FILE, NOT RAW PCM !!!");
            console.error("Gemini Live will hear only static if you send a WAV header.");
            process.exit(1);
        }

        const duration = audioBuffer.length / 32000; // 16khz * 16bit(2bytes)
        console.log(`--- [SANITY] Audio: ${audioBuffer.length} bytes (~${duration.toFixed(2)}s) ---`);
        base64Audio = audioBuffer.toString('base64');
    }

    console.log("--- [STEP 2] Initializing SDK Session ---");
    const session = await genAI.live.connect({
        model: MODEL,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Listen to the audio and describe the image. Be specific about Firebase vs Supabase." }] }
        },
        callbacks: {
            onmessage: (msg) => {
                // Log the structure but hide giant binary blobs
                console.log("--- [INCOMING] ---", JSON.stringify(msg, (k,v) => k === 'data' ? '[BINARY]' : v, 2));
                
                if (msg.serverContent?.modelTurn || msg.serverContent?.outputTranscription) {
                    console.log("--- [SUCCESS] Content Received! ---");
                    // Keep it alive long enough to get the whole voice response
                    setTimeout(() => process.exit(0), 10000);
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); },
            onclose: (e) => console.log(`--- [SDK CLOSED] ${e.code}: ${e.reason} ---`)
        }
    });

    console.log("--- [STEP 3] Connection Established. Drip-Feeding Audio... ---");
    
    if (base64Audio) {
        const CHUNK_SIZE = 4096; // ~128ms of audio per chunk
        for (let i = 0; i < base64Audio.length; i += CHUNK_SIZE) {
            const chunk = base64Audio.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput([{ data: chunk, mimeType: 'audio/pcm;rate=16000' }]);
            await new Promise(r => setTimeout(r, 20)); // Slow down to match human speech speed
        }
        console.log("--- [INFO] Audio streaming complete. ---");
    }

    console.log("--- [STEP 4] Waiting for Audio to 'Settle' in AI brain... ---");
    // 5 second delay is the sweet spot for 10s of audio
    await new Promise(r => setTimeout(r, 5000));

    console.log("--- [STEP 5] Sending Atomic Turn (Image + Question) ---");
    session.sendClientContent({
        turns: [{
            parts: [
                { text: "Task: 1. Transcribe the audio I just streamed. 2. Describe the EXACT image attached to THIS message. Do not hallucinate. If the audio is missing, say so." },
                { inline_data: { mime_type: "image/jpeg", data: base64Image } }
            ]
        }],
        turnComplete: true
    });

    console.log("--- [STEP 5] Final payload sent. Waiting for AI... ---");

    // Master timeout
    setTimeout(() => { console.log("--- [FATAL] Global Timeout ---"); process.exit(1); }, 45000);
}

runTest().catch(console.error);