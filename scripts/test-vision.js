const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    
    // YOUR HOLY MODEL STRING
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

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
        const buffer = Buffer.from(await audioBlob.arrayBuffer());
        
        // SANITY CHECK 1: File Header
        const header = buffer.slice(0, 4).toString('ascii');
        if (header === 'RIFF' || header === 'WAVE') {
            throw new Error("FATAL: audio.pcm is actually a WAV file! Gemini Live requires RAW PCM. Strip the header first.");
        }

        // SANITY CHECK 2: Duration
        const durationSec = buffer.length / 32000;
        console.log(`--- [SANITY] Audio length: ${durationSec.toFixed(2)} seconds ---`);
        
        base64Audio = buffer.toString('base64');
    }
    
    console.log(`--- [STEP 2] Image (${base64Image.length} chars) | Audio (${base64Audio?.length || 0} chars) ---`);
    
    console.log(`--- [STEP 2] Image (${base64Image.length} chars) | Audio (${audioBuffer?.length || 0} bytes) ---`);
    console.log(`--- [STEP 2] Files Ready. Initializing SDK Session... ---`);

    const session = await genAI.live.connect({
        model: MODEL,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio I stream and describe the image I send. Prove you have eyes and ears." }] }
        },
        callbacks: {
            onmessage: (message) => {
                // Filter out the giant binary voice data so we can see the text logic
                console.log("--- [INCOMING] ---", JSON.stringify(message, (k,v) => k === 'data' ? '[BINARY]' : v, 2));
                
                if (message.serverContent?.modelTurn || message.serverContent?.outputTranscription) {
                    console.log("--- [SUCCESS] Content Received! ---");
                    // Wait a bit to catch the full spoken response before exiting
                    setTimeout(() => process.exit(0), 8000);
                }
            },
            onerror: (err) => {
                console.error("--- [SDK ERROR] ---", err);
                process.exit(1);
            },
            onclose: (e) => {
                console.log("--- [SDK CLOSED] ---", e);
            }
        }
    });

    console.log("--- [STEP 3] SDK Session Connected. Streaming Audio... ---");
    
    if (audioBuffer) {
        console.log("--- [INFO] Drip-feeding Audio Buffer... ---");
        // THE DRIP-FEED: Slice the BUFFER, then encode to BASE64 to maintain alignment
        const CHUNK_SIZE = 2048; // 2048 bytes = 1024 samples = 64ms at 16khz
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            const b64Chunk = chunk.toString('base64');
            session.sendRealtimeInput([{ data: b64Chunk, mimeType: 'audio/pcm;rate=16000' }]);
            // Wait 50ms between chunks to simulate real-time speech
            await new Promise(r => setTimeout(r, 50));
        }
        console.log("--- [INFO] Audio Stream Complete ---");
    }

    console.log("--- [STEP 4] Injecting Image Frame... ---");
    session.sendRealtimeInput([{ data: base64Image, mimeType: 'image/jpeg' }]);

    console.log("--- [STEP 5] Sending Final Nudge... ---");
                // 2. WAIT FOR PROCESSING (Calculated delay)
                const waitTime = 5000; 
                console.log(`--- [INFO] Waiting ${waitTime/1000}s for AI to digest the stream... ---`);
                
                setTimeout(() => {
                    console.log("--- [STEP 5] Sending Final Atomic Turn... ---");
                    session.sendClientContent({
                        turns: [{
                            role: "user",
                            parts: [
                                { text: "What did the audio say about Firebase and Supabase? Also describe the screen." }
                            ]
                        }],
                        turnComplete: true
                    });
                    console.log("--- [INFO] Request complete. Waiting for AI to prove it has ears... ---");
                }, waitTime);

    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(1); }, 60000);
}

runTest().catch(console.error);