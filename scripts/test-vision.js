const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

    console.log("--- [STEP 1] Fetching target files ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    const imageFile = files.filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg')).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!imageFile) throw new Error("No images found!");

    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const base64Audio = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()).toString('base64') : null;
    
    console.log(`--- [STEP 2] Files ready. Image (${base64Image.length}) Audio (${base64Audio?.length || 0}) ---`);

    const session = await genAI.live.connect({
        model: MODEL,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio I stream and describe the image I send. If you hear a command in the audio, follow it." }] }
        },
        callbacks: {
            onmessage: (message) => {
                console.log("--- [INCOMING] ---", JSON.stringify(message, (k,v) => k === 'data' ? '[BINARY]' : v, 2));
                if (message.serverContent?.modelTurn || message.serverContent?.outputTranscription) {
                    console.log("--- [SUCCESS] AI is responding! ---");
                    setTimeout(() => process.exit(0), 10000);
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); },
            onclose: (e) => console.log(`--- [SDK CLOSED] ${e.code}: ${e.reason} ---`)
        }
    });

    console.log("--- [STEP 3] Drip-Feeding Audio... ---");
    if (base64Audio) {
        const CHUNK_SIZE = 4096;
        for (let i = 0; i < base64Audio.length; i += CHUNK_SIZE) {
            session.sendRealtimeInput([{ data: base64Audio.slice(i, i + CHUNK_SIZE), mimeType: 'audio/pcm;rate=16000' }]);
            await new Promise(r => setTimeout(r, 25));
        }
        console.log("--- [INFO] Audio Stream Complete. ---");
    }

    console.log("--- [STEP 4] Sending Image via Realtime Pipe... ---");
    session.sendRealtimeInput([{ data: base64Image, mimeType: 'image/jpeg' }]);

    console.log("--- [STEP 5] Waiting for processing (4s)... ---");
    await new Promise(r => setTimeout(r, 4000));

    console.log("--- [STEP 6] Sending Text Nudge... ---");
    // Using the simplest possible structure for the nudge to avoid 1007
    session.sendClientContent({
        turns: [{ parts: [{ text: "What did that audio clip say about Firebase and Supabase? Also, what do you see on my screen right now?" }] }],
        turnComplete: true
    });

    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(1); }, 60000);
}

runTest().catch(console.error);