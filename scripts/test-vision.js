const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading audio.pcm ---");
    const { data: audioBlob, error } = await supabase.storage.from('Audio').download('audio.pcm');
    if (error || !audioBlob) throw new Error("audio.pcm not found!");
    
    const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    // Diagnostic: Check if file is silent (all zeros)
    const sample = audioBuffer.slice(0, 20).toString('hex');
    console.log(`--- [INFO] Audio Ready: ${audioBuffer.length} bytes. Data start: ${sample} ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const config = {
        responseModalities: ['AUDIO'],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        speechConfig: { voice_config: { prebuilt_voice_config: { voice_name: 'Puck' } } },
        systemInstruction: { parts: [{ text: "You are a precise transcriber. Listen to the user's speech and output the exact text you hear. Do not summarize." }] }
    };

    console.log("--- [STEP 2] Connecting... ---");
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,
        callbacks: {
            onmessage: (message) => {
                if (message.serverContent?.outputTranscription) {
                    console.log("--- [AI TRANSCRIBED] ---", message.serverContent.outputTranscription.text);
                }
                if (message.serverContent?.modelTurn) {
                    const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
                    if (textPart) console.log("--- [AI RESPONSE] ---", textPart.text);
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); }
        }
    });

    await new Promise(r => setTimeout(r, 2000));

    console.log("--- [STEP 3] Opening Turn & Streaming Audio ---");

    // 1. Tell the AI to start listening (Turn remains OPEN)
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Please transcribe the following speech:" }] }],
        turnComplete: false
    });

    // 2. Drip-feed the audio
    const CHUNK_SIZE = 1024;
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
        session.sendRealtimeInput([{
            data: chunk.toString('base64'),
            mimeType: 'audio/pcm;rate=16000'
        }]);
        
        // 30ms delay mimics real speech pace
        await new Promise(r => setTimeout(r, 30));
        
        if (i % (CHUNK_SIZE * 100) === 0) {
            console.log(`--- [PROGRESS] Streaming ${Math.round((i/audioBuffer.length)*100)}% ---`);
        }
    }

    // 3. Finalize the Turn
    console.log("--- [STEP 4] Closing Turn... ---");
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "(End of audio)" }] }],
        turnComplete: true
    });

    // Wait 10s for the AI to process the full 20s of audio
    setTimeout(() => { 
        console.log("--- [SUCCESS] Test window closed. Check logs above for transcription. ---"); 
        process.exit(0); 
    }, 10000);
}

runTest().catch(err => { console.error(err); process.exit(1); });