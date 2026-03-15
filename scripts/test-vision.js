const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const MODEL_ID = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
    
    console.log("--- [STEP 1] Downloading audio.pcm ---");
    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    if (!audioBlob) throw new Error("audio.pcm not found in bucket!");
    const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    
    console.log(`--- [INFO] Audio Loaded: ${audioBuffer.length} bytes ---`);

    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const config = {
        responseModalities: ['AUDIO'],
        // Enable transcription for both sides
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "You are a transcription bot. Listen to the user audio and repeat what they said exactly." }] }
    };

    console.log("--- [STEP 2] Connecting to Gemini Live... ---");
    
    const session = await genAI.live.connect({
        model: MODEL_ID,
        config: config,
        callbacks: {
            onmessage: (message) => {
                // 1. This is what the AI thinks IT heard from the user
                if (message.serverContent?.inputAudioTranscription?.text) {
                  console.log("--- [TRANSCRIPTION OF YOUR PCM] ---", message.serverContent.inputAudioTranscription.text);
                }

                // 2. This is the text of the AI's actual reply
                if (message.serverContent?.modelTurn) {
                    const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
                    if (textPart) console.log("--- [AI REPLY] ---", textPart.text);
                }

                if (message.serverContent?.turnComplete) {
                    console.log("--- [SUCCESS] Turn Finished ---");
                    setTimeout(() => process.exit(0), 3000);
                }
            },
            onerror: (err) => {
                console.error("--- [SDK ERROR] ---", err);
                process.exit(1);
            }
        }
    });

    console.log("--- [STEP 3] Session Ready. Drip-feeding micro-chunks... ---");

    // 1. WAV HEADER CHECK
    if (audioBuffer.toString('utf8', 0, 4) === 'RIFF') {
        console.error("--- [FATAL] audio.pcm is actually a WAV file! Gemini needs RAW PCM. ---");
        process.exit(1);
    }

    // 2. REAL-TIME DRIP-FEED
    // 16000 Hz * 2 bytes (16-bit) = 32000 bytes per second.
    // 1024 bytes = 32ms of audio.
    const CHUNK_SIZE = 1024;
    const CHUNK_DELAY_MS = 32; 

    console.log(`--- [STEP 3] Streaming ${audioBuffer.length} bytes at Real-Time speed (~${Math.round(audioBuffer.length/32000)}s)... ---`);

    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
        
        // Using the exact 'media' structure from the demo repo
        session.sendRealtimeInput({
            media: {
                data: chunk.toString('base64'),
                mimeType: 'audio/pcm;rate=16000'
            }
        });

        await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
        
        if (i % (CHUNK_SIZE * 100) === 0) {
          console.log(`--- [PROGRESS] Sent ${Math.round((i/audioBuffer.length)*100)}% ---`);
        }
    }

    console.log("--- [STEP 4] Audio stream finished. Prompting for transcription... ---");
    session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: "Please transcribe the audio clip I just sent you in full." }] }],
        turnComplete: true
    });

    setTimeout(() => { 
        console.log("--- [FATAL] Timeout ---"); 
        process.exit(1); 
    }, 90000);
}

runTest().catch(err => {
    console.error("--- [UNCAUGHT ERROR] ---", err);
    process.exit(1);
});