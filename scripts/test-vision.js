const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading audio.pcm ---");
    const { data: audioBlob, error } = await supabase.storage.from('Audio').download('audio.pcm');
    if (error || !audioBlob) throw new Error("audio.pcm not found!");
    
    const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    console.log(`--- [INFO] Audio Ready: ${audioBuffer.length} bytes ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const config = {
        responseModalities: ['AUDIO'],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "You are AgentX. Your only job is to transcribe the audio stream you receive. If the stream is silent, say 'I hear nothing'. If you hear speech, repeat it exactly." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini Live... ---");
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,
        callbacks: {
            onmessage: (message) => {
                if (message.serverContent?.outputTranscription) {
                    console.log("--- [AI TRANSCRIBED] ---", message.serverContent.outputTranscription.text);
                }
                if (message.serverContent?.modelTurn) {
                    const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
                    if (textPart) console.log("--- [AI RESPONSE] ---", textPart.text);
                }
                if (message.serverContent?.turnComplete) {
                    console.log("--- [SUCCESS] Content received. ---");
                    setTimeout(() => process.exit(0), 2000);
                }
            },
            onerror: (err) => { console.error("--- [SDK ERROR] ---", err); process.exit(1); }
        }
    });

    // Wait for internal SDK ready state
    await new Promise(r => setTimeout(r, 2000));

    console.log("--- [STEP 3] Pumping Audio Buffer (1024-byte chunks) ---");
    const CHUNK_SIZE = 1024;
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
        // Send directly to realtime input without an accompanying text turn
        session.sendRealtimeInput([{
            data: chunk.toString('base64'),
            mimeType: 'audio/pcm;rate=16000'
        }]);
        
        // Slow the pump slightly to match realtime (32ms of data per chunk)
        await new Promise(r => setTimeout(r, 25));
        
        if (i % (CHUNK_SIZE * 100) === 0) {
            console.log(`--- [PROGRESS] Pumping: ${Math.round((i/audioBuffer.length)*100)}% ---`);
        }
    }

    console.log("--- [STEP 4] Buffer full. Requesting Transcription... ---");
    
    // Wait a brief moment for the last chunk to be processed
    await new Promise(r => setTimeout(r, 1000));

    // Send the instruction turn NOW, after the data is already in the AI's 'ear'
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Please transcribe the audio I just streamed to you. What did it say?" }] }],
        turnComplete: true
    });

    setTimeout(() => { console.log("--- [TIMEOUT] No AI response ---"); process.exit(1); }, 40000);
}

runTest().catch(err => { console.error(err); process.exit(1); });