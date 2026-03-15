const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Fetching Files ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    const imageFile = files.filter(f => f.name.endsWith('.jpg')).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBuffer = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()) : null;
    
    console.log(`--- [INFO] Ready: Image(${imageFile.name}) Audio(${audioBuffer?.length} bytes) ---`);

    // Force v1beta via the client constructor if possible, or via model string
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    
    const config = {
        responseModalities: ['AUDIO'],
        mediaResolution: 'MEDIA_RESOLUTION_MEDIUM', // SECRET SAUCE 1
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        // SECRET SAUCE 2: Sliding window helps the model not 'forget' the start of the audio
        contextWindowCompression: {
            triggerTokens: 104857,
            slidingWindow: { targetTokens: 52428 }
        },
        systemInstruction: { parts: [{ text: "You are AgentX. A multimodal expert. Follow instructions exactly." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini v1beta... ---");
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,
        callbacks: {
            onmessage: (msg) => {
                if (msg.serverContent?.outputTranscription) console.log("--- [AI HEARD] ---", msg.serverContent.outputTranscription.text);
                if (msg.serverContent?.modelTurn) {
                    const t = msg.serverContent.modelTurn.parts.find(p => p.text)?.text;
                    if (t) console.log("--- [AI SAID] ---", t);
                }
            },
            onerror: (e) => { console.error("--- [ERROR] ---", e); process.exit(1); }
        }
    });

    await new Promise(r => setTimeout(r, 2000));

    // 1. STREAM AUDIO FIRST (At real-time speed)
    if (audioBuffer) {
        console.log("--- [STEP 3] Streaming Audio at 32KB/s (Simulating real-time)... ---");
        const CHUNK_SIZE = 2048; 
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput([{ data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }]);
            // 60ms delay matches the data duration (~16k samples/sec)
            await new Promise(r => setTimeout(r, 60));
        }
    }

    console.log("--- [STEP 4] Audio buffered. Sending Final Atomic Turn... ---");

    // 2. ATOMIC TURN: Image + Command
    // This ensures the AI 'sees' the image at the same time it receives the order
    // and looks back at the audio buffer we just filled.
    session.sendClientContent({
        turns: [{
            role: 'user',
            parts: [
                { text: "Analyze the audio I just streamed and describe this image in detail. Prove you can see the AgentX Controller app." },
                { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
            ]
        }],
        turnComplete: true
    });

    // Wait for the slow-thinking brain to respond
    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(0); }, 30000);
}

runTest().catch(console.error);