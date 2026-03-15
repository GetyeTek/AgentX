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
    
    // Mimicking the Python Cookbook Config EXACTLY
    const config = {
        responseModalities: ['AUDIO'],
        mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
        // THE DEMENTIA FIX: Sliding Window
        contextWindowCompression: {
            triggerTokens: 104857,
            slidingWindow: { targetTokens: 52428 }
        },
        systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio and describe the image. Be brief." }] }
    };

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

    console.log("--- [STEP 3] Interleaving Data (Python Style) ---");

    // 1. Send Text Command into buffer
    session.sendRealtimeInput([{ text: "Please analyze this screen and transcribe the audio." }]);

    // 2. Stream Audio
    if (audioBuffer) {
        const CHUNK_SIZE = 1024;
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput([{ data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }]);
            await new Promise(r => setTimeout(r, 20));
        }
    }

    // 3. Send Image and FINALIZE turn in one go
    console.log("--- [STEP 4] Finalizing with Image... ---");
    session.sendClientContent({
        turns: [{
            role: 'user',
            parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64Image } }]
        }],
        turnComplete: true
    });

    setTimeout(() => { console.log("--- [FINISH] ---"); process.exit(0); }, 15000);
}

runTest().catch(console.error);