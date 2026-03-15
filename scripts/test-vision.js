const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    const { data: files } = await supabase.storage.from('Audio').list();
    const imageFile = files.filter(f => f.name.endsWith('.jpg')).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBuffer = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()) : null;

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    // Initialize with v1beta as per Google Cookbook
    const genAI = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        apiVersion: 'v1beta'
    });

    const config = {
        responseModalities: ['AUDIO'],
        mediaResolution: 'MEDIA_RESOLUTION_MEDIUM', // From Cookbook
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio and describe the image. Prove you can see the screen buttons." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini Live (v1beta)... ---");
    
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,

    console.log("--- [STEP 2] Connecting with Cookbook Config... ---");
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,
        callbacks: {
            onmessage: (msg) => {
                if (msg.serverContent?.outputTranscription) console.log("--- [HEARD] ---", msg.serverContent.outputTranscription.text);
                if (msg.serverContent?.modelTurn) {
                    const t = msg.serverContent.modelTurn.parts.find(p => p.text)?.text;
                    if (t) console.log("--- [SAID] ---", t);
                }
            },
            onerror: (e) => { console.error("--- [ERROR] ---", e); process.exit(1); }
        }
    });

    console.log("--- [STEP 3] Session Ready. Streaming Media into Buffer... ---");

    // 1. Send Image into the rolling buffer first
    console.log("--- [INFO] Sending Vision Frame... ---");
    session.sendRealtimeInput([{
        data: base64Image,
        mimeType: 'image/jpeg'
    }]);

    // 2. Drip-feed audio into the buffer
    if (audioBuffer) {
        const CHUNK_SIZE = 2048; 
        console.log("--- [INFO] Pumping audio... ---");
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput([{
                data: chunk.toString('base64'),
                mimeType: 'audio/pcm;rate=16000'
            }]);
            await new Promise(r => setTimeout(r, 25));
        }
    }

    // 3. The Cookbook Trigger: Send a turn to claim the buffer
    console.log("--- [STEP 4] Media Streamed. Triggering Turn... ---");
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Look at the image I just sent and listen to the audio. Give me the transcription and the description now." }] }],
        turnComplete: true
    });
    setTimeout(() => { console.log("--- [FINISH] ---"); process.exit(0); }, 15000);
}

runTest().catch(console.error);