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

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio and describe the screen accurately. Prove you can hear and see simultaneously." }] }
        },
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

    console.log("--- [STEP 2] Streaming Audio (Repo-Style) ---");

    if (audioBuffer) {
        const CHUNK_SIZE = 2048;
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            // CRITICAL: Using the exact object-based signature from the demo repo
            session.sendRealtimeInput({
                media: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
            });
            await new Promise(r => setTimeout(r, 10));
        }
    }

    console.log("--- [STEP 3] Closing Turn with Atomic Vision... ---");
    
    // 4. ATOMIC VISION TURN
    // We put the image and text here to ensure the AI 'looks' at them while answering
    session.sendClientContent({
        turns: [{
            role: 'user',
            parts: [
                { text: "Describe the screen image provided here and transcribe the audio I just streamed." },
                { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
            ]
        }],
        turnComplete: true
    });

    setTimeout(() => { console.log("--- [SUCCESS] Test window closing. ---"); process.exit(0); }, 15000);
}

runTest().catch(console.error);