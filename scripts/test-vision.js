const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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
    
    console.log(`--- [INFO] Files Ready: Image(${imageFile.name}) Audio(${audioBuffer?.length || 0} bytes) ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const config = {
        responseModalities: ['AUDIO'],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio and describe the image. Be extremely specific." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini Live... ---");
    
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,
        callbacks: {
            onopen: async () => {
                console.log("--- [STEP 3] Session Opened. Starting Multi-modal Injection... ---");

                // 1. DRIP-FEED AUDIO
                if (audioBuffer) {
                    const CHUNK_SIZE = 4000;
                    console.log("--- [INFO] Drip-feeding audio chunks... ---");
                    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
                        const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
                        session.sendRealtimeInput([{
                            data: chunk.toString('base64'),
                            mimeType: 'audio/pcm;rate=16000'
                        }]);
                        await new Promise(r => setTimeout(r, 20));
                    }
                }

                // 2. SEND IMAGE
                console.log("--- [INFO] Sending Vision Frame... ---");
                session.sendRealtimeInput([{
                    data: base64Image,
                    mimeType: 'image/jpeg'
                }]);

                // 3. ASK THE QUESTION
                console.log("--- [STEP 4] Finalizing Turn... ---");
                session.sendClientContent({
                    turns: [{ role: 'user', parts: [{ text: "What is in the image and what did the audio say?" }] }],
                    turnComplete: true
                });
            },
            onmessage: (message) => {
                if (message.serverContent?.outputTranscription) {
                    console.log("--- [AI HEARD] ---", message.serverContent.outputTranscription.text);
                }
                if (message.serverContent?.modelTurn) {
                    const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
                    if (textPart) console.log("--- [AI SAID] ---", textPart.text);
                    
                    if (message.serverContent.turnComplete) {
                        console.log("--- [SUCCESS] Content received. Closing... ---");
                        setTimeout(() => process.exit(0), 1000);
                    }
                }
            },
            onerror: (err) => {
                console.error("--- [SDK ERROR] ---", err);
                process.exit(1);
            },
            onclose: (event) => {
                console.log("--- [SESSION CLOSED] ---", event);
            }
        }
    });

    // Safety timeout
    setTimeout(() => { 
        console.log("--- [FATAL] Test timed out after 60s. ---"); 
        process.exit(1); 
    }, 60000);
}

runTest().catch(err => {
    console.error("--- [UNCAUGHT ERROR] ---", err);
    process.exit(1);
});