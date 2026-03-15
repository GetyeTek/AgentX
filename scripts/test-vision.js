const { GoogleGenAI, Modality } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading Media ---");
    const { data: files, error: listError } = await supabase.storage.from('Audio').list();
    if (listError) throw listError;

    // 1. Get the latest Image
    const imageFile = files
        .filter(f => f.name.endsWith('.jpg'))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

    if (!imageFile) throw new Error("No .jpg files found in bucket.");

    const { data: { publicUrl } } = supabase.storage.from('Audio').getPublicUrl(imageFile.name);
    console.log(`[FILE INFO] Image: ${imageFile.name} | Size: ${imageFile.metadata.size} bytes | URL: ${publicUrl}`);

    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    // 2. Get the Audio
    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const audioBuffer = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()) : null;
    
    if (audioBuffer) {
        console.log(`[FILE INFO] Audio: audio.pcm | Size: ${audioBuffer.length} bytes (~${(audioBuffer.length / 32000).toFixed(2)}s)`);
    } else {
        console.warn("[WARNING] audio.pcm not found or empty.");
    }

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: {
            responseModalities: [Modality.AUDIO],
            mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
            outputAudioTranscription: {},
            systemInstruction: { 
                parts: [{ text: "You are AgentX. Look at the image provided in the turn. Describe the status (Online/Offline) and the buttons clearly. Transcribe any audio context provided." }] 
            }
        },
        callbacks: {
            onmessage: (msg) => {
                // The AI's reasoned response
                if (msg.serverContent?.modelTurn?.parts) {
                    const textPart = msg.serverContent.modelTurn.parts.find(p => p.text);
                    if (textPart) console.log("--- [AI RESPONSE TEXT] ---", textPart.text);
                }
                // The transcription of the AI's spoken voice
                if (msg.serverContent?.outputAudioTranscription) {
                    console.log("--- [AI VOICE TRANSCRIPTION] ---", msg.serverContent.outputAudioTranscription.text);
                }
            },
            onerror: (e) => { console.error("--- [ERROR] ---", e); process.exit(1); }
        }
    });

    await new Promise(r => setTimeout(r, 2000));

    console.log("--- [STEP 2] Streaming Audio Content ---");

    if (audioBuffer) {
        const CHUNK_SIZE = 1024;
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
            const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
            session.sendRealtimeInput({
                mediaChunks: [{ data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }]
            });
            await new Promise(r => setTimeout(r, 25));
        }
    }

    console.log("--- [STEP 3] Injecting Image Inline and Finalizing Turn ---");
    
    session.sendClientContent({
        turns: [{
            role: 'user',
            parts: [
                { inlineData: { data: base64Image, mimeType: 'image/jpeg' } },
                { text: "Analyze the attached screenshot of the AgentX Controller and the audio I just streamed. What is the current state?" }
            ]
        }],
        turnComplete: true
    });

    // Hold open for response
    setTimeout(() => { console.log("--- [TEST COMPLETE] ---"); process.exit(0); }, 30000);
}

runTest().catch(console.error);