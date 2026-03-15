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
            systemInstruction: { parts: [{ text: "You are AgentX. You process a live multimodal stream. Transcribe all audio and describe the UI accurately." }] }
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

    // Give the SDK a second to warm up
    await new Promise(r => setTimeout(r, 2000));

    console.log("--- [STEP 2] Sending Stream Data... ---");

    // 1. Send Text Instruction into the STREAM (Not a Turn)
    session.sendRealtimeInput([{ text: "Instruction: Transcribe the following audio and describe the screen image I am about to send." }]);

    // 2. Send Image into the STREAM
    session.sendRealtimeInput([{ data: base64Image, mimeType: 'image/jpeg' }]);

    // 3. Drip-feed Audio into the STREAM
    if (audioBuffer) {
        const CHUNK_SIZE = 1024;
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput([{ data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }]);
            await new Promise(r => setTimeout(r, 20)); // Flow pace
        }
    }

    console.log("--- [STEP 3] Stream Finished. Closing Turn... ---");
    
    // 4. SIGNAL TURN COMPLETE
    // This is the only place we use sendClientContent in the whole flow
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "I am done sending data. Please provide the analysis now." }] }],
        turnComplete: true
    });

    // Final wait for response
    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(0); }, 20000);
}

runTest().catch(console.error);