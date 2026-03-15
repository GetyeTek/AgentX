const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

    console.log("--- [STEP 1] Fetching target files ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    
    const imageFile = files
        .filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!imageFile) throw new Error("No JPEG images found in bucket!");
    
    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob, error: audioErr } = await supabase.storage.from('Audio').download('audio.pcm');
    let base64Audio = null;

    if (!audioErr && audioBlob) {
        const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
        
        // --- PCM SANITY CHECK ---
        const duration = audioBuffer.length / 32000;
        console.log("--- [SANITY CHECK] ---");
        console.log(`File Size: ${audioBuffer.length} bytes | Duration: ${duration.toFixed(2)}s`);
        
        // SLICE TO 5 SECONDS TO PREVENT 1011 ERROR
        const fiveSecondsInBytes = 16000 * 2 * 5;
        const slicedBuffer = audioBuffer.slice(0, fiveSecondsInBytes);
        console.log(`--- [INFO] Slicing audio to first 5 seconds (${slicedBuffer.length} bytes) ---`);

        base64Audio = slicedBuffer.toString('base64');
    }

    console.log(`--- [STEP 2] Payload: Image(${base64Image.length} chars) | Audio(${base64Audio?.length || 0} chars) ---`);

    const session = await genAI.live.connect({
        model: MODEL,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Describe exactly what you see in the images provided and transcribe exactly what you hear in the audio provided. Do not guess." }] }
        },
        callbacks: {
            onmessage: (message) => {
                const loggable = JSON.stringify(message, (k,v) => k === 'data' ? '[BINARY]' : v, 2);
                console.log("--- [INCOMING] ---", loggable);
                
                if (message.serverContent?.modelTurn || message.serverContent?.outputTranscription) {
                    console.log("--- [SUCCESS] Received Content! ---");
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); },
            onclose: (e) => console.log(`--- [SDK CLOSED] ${e.code}: ${e.reason} ---`)
        }
    });

    console.log("--- [STEP 3] SDK Connected. Preparing Atomic Multimodal Turn... ---");
    
    // We package everything into ONE message so the AI can't ignore the parts
    const turnParts = [
        { text: "Describe exactly what you see in the image and transcribe exactly what you hear in the audio clip. Do not say you see or hear nothing." },
        { inline_data: { data: base64Image, mimeType: 'image/jpeg' } }
    ];

    if (base64Audio) {
        turnParts.push({ inline_data: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' } });
    }

    console.log("--- [STEP 4] Sending Atomic Turn (Image + 5s Audio) ---");
    session.sendClientContent({
        turns: [{ role: 'user', parts: turnParts }],
        turnComplete: true
    });

    // Keep alive to catch the response
    setTimeout(() => {
        console.log("--- [END] Test Finished. ---");
        process.exit(0);
    }, 15000);
}

runTest().catch(console.error);