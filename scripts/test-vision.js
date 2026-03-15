const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    // BACK TO THE BLOOD-EARNED VERSION
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading audio.pcm ---");
    const { data: audioBlob, error } = await supabase.storage.from('Audio').download('audio.pcm');
    if (error || !audioBlob) throw new Error("audio.pcm not found!");
    
    const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    console.log(`--- [INFO] Audio Ready: ${audioBuffer.length} bytes ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const config = {
        responseModalities: ['AUDIO'],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "You are a transcription bot. Listen to the audio and transcribe it perfectly into text." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini Live... ---");
    
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
                    setTimeout(() => process.exit(0), 2000);
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); },
            onclose: (e) => console.log("--- [CLOSED] ---", e)
        }
    });

    // Wait 1s for the WebSocket to actually stabilize inside the SDK
    await new Promise(r => setTimeout(r, 1000));

    console.log("--- [STEP 3] Pumping Audio (1024-byte chunks) ---");

    // 1. Initial Prompt
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Start transcribing now." }] }],
        turnComplete: false
    });

    // 2. Drip-feed
    const CHUNK_SIZE = 1024;
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
        session.sendRealtimeInput([{
            data: chunk.toString('base64'),
            mimeType: 'audio/pcm;rate=16000'
        }]);
        await new Promise(r => setTimeout(r, 20));
        
        if (i % (CHUNK_SIZE * 50) === 0) {
            console.log(`--- [PROGRESS] Sent ${i}/${audioBuffer.length} bytes ---`);
        }
    }

    // 3. Finalize Turn with correct SDK structure
    console.log("--- [STEP 4] Audio Streamed. Finalizing... ---");
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "End of audio. Transcribe what you heard." }] }],
        turnComplete: true
    });

    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(1); }, 60000);
}

runTest().catch(err => { console.error(err); process.exit(1); });