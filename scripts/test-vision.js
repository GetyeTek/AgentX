const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

    console.log("--- [STEP 1] Fetching target files ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    
    const imageFile = files
        .filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!imageFile) throw new Error("No JPEG images found in bucket!");
    
    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob, error: audioErr } = await supabase.storage.from('Audio').download('audio.pcm');
    let base64Audio = null;

    if (!audioErr && audioBlob) {
        const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
        
        // --- PCM SANITY CHECK ---
        const hexHeader = audioBuffer.slice(0, 16).toString('hex').toUpperCase();
        const asciiHeader = audioBuffer.slice(0, 4).toString('ascii');
        const duration = audioBuffer.length / 32000; // 16khz * 2 bytes

        console.log("--- [SANITY CHECK] ---");
        console.log(`File Size: ${audioBuffer.length} bytes`);
        console.log(`Estimated Duration: ${duration.toFixed(2)}s`);
        console.log(`Hex Header: ${hexHeader}`);
        
        if (asciiHeader === 'RIFF' || asciiHeader === 'WAVE') {
            console.warn("!!! WARNING: This file looks like a WAV file, NOT RAW PCM !!!");
        } else {
            console.log("Header looks like Raw Data (Good).");
        }
        // -------------------------

        base64Audio = audioBuffer.toString('base64');
    }

    console.log(`--- [STEP 2] Payload: Image(${base64Image.length} chars) | Audio(${base64Audio?.length || 0} chars) ---`);

    const session = await genAI.live.connect({
        model: MODEL,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio exactly and describe the image. Prove you have eyes and ears." }] }
        },
        callbacks: {
            onmessage: (message) => {
                const loggable = JSON.stringify(message, (k,v) => k === 'data' ? '[BINARY]' : v, 2);
                console.log("--- [INCOMING] ---", loggable);
                
                if (message.serverContent?.modelTurn || message.serverContent?.outputTranscription) {
                    console.log("--- [SUCCESS] Received Content! ---");
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); },
            onclose: (e) => console.log(`--- [SDK CLOSED] ${e.code}: ${e.reason} ---`)
        }
    });

    console.log("--- [STEP 3] SDK Connected. Drip-feeding Audio... ---");
    
    if (base64Audio) {
        const CHUNK_SIZE = 4096;
        for (let i = 0; i < base64Audio.length; i += CHUNK_SIZE) {
            const chunk = base64Audio.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput([{ data: chunk, mimeType: 'audio/pcm;rate=16000' }]);
            await new Promise(r => setTimeout(r, 25));
        }
        console.log("--- [INFO] Audio Stream Complete ---");
    }

    // Let the audio 'sink in' for 2 seconds before the vision turn
    await new Promise(r => setTimeout(r, 2000));

    console.log("--- [STEP 4] Sending Vision + Final Nudge... ---");
    session.sendRealtimeInput([{ data: base64Image, mimeType: 'image/jpeg' }]);

    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Transcribe the audio about Firebase/Supabase and describe my screen." }] }],
        turnComplete: true
    });

    // Keep alive to catch the response
    setTimeout(() => {
        console.log("--- [END] Test Finished. ---");
        process.exit(0);
    }, 15000);
}

runTest().catch(console.error);