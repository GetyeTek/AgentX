const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    // Keeping your blood-earned model string
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading Files from Supabase ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    const imageFile = files
        .filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!imageFile) throw new Error("No JPEG found!");

    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBuffer = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()) : null;
    
    console.log(`--- [INFO] Payload Ready: Image(${imageFile.name}) Audio(${audioBuffer?.length || 0} bytes) ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio and describe the image. Be extremely specific." }] }
        }
    });

    session.on('open', async () => {
        console.log("--- [STEP 2] SDK Session Opened ---");

        // 1. DRIP-FEED AUDIO (The 1011 Fix)
        if (audioBuffer) {
            const CHUNK_SIZE = 4000; // ~125ms of audio at 16kHz
            console.log("--- [STEP 3] Drip-feeding audio chunks... ---");
            for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
                const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
                session.sendRealtimeInput([{
                    data: chunk.toString('base64'),
                    mimeType: 'audio/pcm;rate=16000'
                }]);
                // Wait a tiny bit between chunks to avoid flooding Google's ingest buffer
                await new Promise(r => setTimeout(r, 20));
            }
        }

        // 2. SEND IMAGE
        console.log("--- [STEP 4] Sending Vision Frame... ---");
        session.sendRealtimeInput([{
            data: base64Image,
            mimeType: 'image/jpeg'
        }]);

        // 3. ASK THE QUESTION
        console.log("--- [STEP 5] Finalizing Turn... ---");
        session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: "What is in the image and what did the audio say?" }] }],
            turnComplete: true
        });
    });

    session.on('message', (message) => {
        // Log structural info to avoid binary vomit
        if (message.serverContent?.outputTranscription) {
            console.log("--- [AI HEARD] ---", message.serverContent.outputTranscription.text);
        }
        if (message.serverContent?.modelTurn) {
            const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
            if (textPart) console.log("--- [AI SAID] ---", textPart.text);
            
            if (message.serverContent.turnComplete) {
                console.log("--- [SUCCESS] Session Complete ---");
                process.exit(0);
            }
        }
    });

    session.on('error', (err) => {
        console.error("--- [SDK ERROR] ---", err);
        process.exit(1);
    });

    setTimeout(() => { console.log("--- [FATAL] Timeout ---"); process.exit(1); }, 45000);
}

runTest().catch(console.error);