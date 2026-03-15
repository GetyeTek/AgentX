const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    // Using the EXACT model name from the repo
    const MODEL_ID = 'gemini-live-2.5-flash-preview';
    
    console.log("--- [STEP 1] Downloading audio.pcm ---");
    const { data: audioBlob, error } = await supabase.storage.from('Audio').download('audio.pcm');
    if (error || !audioBlob) throw new Error("audio.pcm not found in bucket!");
    
    const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    console.log(`--- [INFO] Audio Ready: ${audioBuffer.length} bytes ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const config = {
        responseModalities: ['AUDIO'],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        systemInstruction: { parts: [{ text: "You are a transcription bot. Listen to the audio and repeat exactly what was said in text." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini Live (SDK)... ---");
    
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
                if (message.serverContent?.turnComplete) {
                    console.log("--- [SUCCESS] Turn Finished ---");
                    setTimeout(() => process.exit(0), 3000);
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); },
            onclose: (e) => console.log("--- [CLOSED] ---", e)
        }
    });

    console.log("--- [STEP 3] Pumping Audio (Tiny 1024-byte chunks) ---");

    // 1. Tell it what to do
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Please transcribe the audio I am about to stream to you." }] }],
        turnComplete: false
    });

    // 2. Drip-feed at repo-exact sizing
    const CHUNK_SIZE = 1024; // Exactly 512 samples * 2 bytes
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
        session.sendRealtimeInput([{
            data: chunk.toString('base64'),
            mimeType: 'audio/pcm;rate=16000'
        }]);
        // 20ms delay to simulate real-time speech pace
        await new Promise(r => setTimeout(r, 20));
        
        if (i % (CHUNK_SIZE * 20) === 0) {
            console.log(`--- [PROGRESS] Sent ${i}/${audioBuffer.length} bytes ---`);
        }
    }

    // 3. Signal end of turn
    console.log("--- [STEP 4] Audio Streamed. Finalizing Turn... ---");
    session.sendClientContent({ turns: [], turnComplete: true });

    setTimeout(() => { console.log("--- [TIMEOUT] No response ---"); process.exit(1); }, 60000);
}

runTest().catch(err => { console.error(err); process.exit(1); });