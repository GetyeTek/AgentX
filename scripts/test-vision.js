const { GoogleGenAI, Modality } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading Media ---");
    const { data: files, error: listError } = await supabase.storage.from('Audio').list();
    if (listError) throw listError;

    // Filter and Log Image Selection
    const imageFiles = files.filter(f => f.name.endsWith('.jpg')).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const imageFile = imageFiles[0];
    
    if (!imageFile) throw new Error("No .jpg files found in 'Audio' bucket.");
    console.log(`[MEDIA] Found ${imageFiles.length} images. Picking latest: ${imageFile.name} (${imageFile.metadata.size} bytes, Created: ${imageFile.created_at})`);

    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    // Audio Sanity Check
    console.log("[MEDIA] Downloading audio.pcm...");
    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBuffer = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()) : null;
    
    if (!audioBuffer || audioBuffer.length < 100) {
        console.warn("[WARNING] audio.pcm is missing or effectively empty.");
    } else {
        console.log(`[MEDIA] Loaded audio.pcm (${audioBuffer.length} bytes / ${(audioBuffer.length / 32000).toFixed(2)}s of audio)`);
    }

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    
    // Using v1beta as per the Python script
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: {
            responseModalities: [Modality.AUDIO],
            mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
            outputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio and describe the image UI in detail." }] }
        },
        callbacks: {
            onmessage: (msg) => {
                // This is the AI transcribing its own generated voice back to you
                if (msg.serverContent?.modelTurn?.parts) {
                    const textPart = msg.serverContent.modelTurn.parts.find(p => p.text);
                    if (textPart) console.log("--- [AI RESPONSE TEXT] ---", textPart.text);
                }
                
                if (msg.serverContent?.outputAudioTranscription) {
                    console.log("--- [AI VOICE TRANSCRIPTION] ---", msg.serverContent.outputAudioTranscription.text);
                }
            },
            onerror: (e) => { console.error("--- [ERROR] ---", e); process.exit(1); }
        }
    });

    await new Promise(r => setTimeout(r, 2000));

    console.log("--- [STEP 2] Streaming Media to Buffer ---");

    // 1. Send Image into stream as a single video/image frame
    session.sendRealtimeInput({
        mediaChunks: [{
            data: base64Image,
            mimeType: 'image/jpeg'
        }]
    });

    // 2. Drip-feed Audio
    if (audioBuffer) {
        const CHUNK_SIZE = 1024;
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput({
                mediaChunks: [{
                    data: chunk.toString('base64'),
                    mimeType: 'audio/pcm;rate=16000'
                }]
            });
            await new Promise(r => setTimeout(r, 25));
        }
    }

    console.log("--- [STEP 3] Media Loaded. Sending Finalized Turn... ---");
    
    // 3. This matches the Python SDK's end_of_turn=True
    session.sendClientContent({
        turns: [{
            role: 'user',
            parts: [{ text: "Please analyze the screen image and the audio I just sent. Give me the results now." }]
        }],
        turnComplete: true
    });

    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(0); }, 30000);
}

runTest().catch(console.error);