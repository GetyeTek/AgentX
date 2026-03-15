const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

async function runTest() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    
    // YOUR HOLY MODEL STRING
    const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

    console.log("--- [STEP 1] Fetching target files ---");
    const { data: files } = await supabase.storage.from('Audio').list();
    const imageFile = files
        .filter(f => f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!imageFile) throw new Error("No JPEG images found in bucket!");
    console.log(`--- [INFO] Using Image: ${imageFile.name} ---`);

    const { data: imgBlob } = await supabase.storage.from('Audio').download(imageFile.name);
    const base64Image = Buffer.from(await imgBlob.arrayBuffer()).toString('base64');

    const { data: audioBlob } = await supabase.storage.from('Audio').download('audio.pcm');
    const base64Audio = audioBlob ? Buffer.from(await audioBlob.arrayBuffer()).toString('base64') : null;
    
    console.log(`--- [STEP 2] Files Ready. Initializing SDK Session... ---`);

    const session = await genAI.live.connect({
        model: MODEL,
        config: {
            responseModalities: ['AUDIO'],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: "You are AgentX. Transcribe the audio I stream and describe the image I send. Prove you have eyes and ears." }] }
        },
        callbacks: {
            onopen: async () => {
                console.log("--- [STEP 3] SDK Session Opened. Streaming Audio... ---");
                
                if (base64Audio) {
                    // THE DRIP-FEED: Send audio in small chunks to prevent 1011 Internal Error
                    const CHUNK_SIZE = 4096;
                    for (let i = 0; i < base64Audio.length; i += CHUNK_SIZE) {
                        const chunk = base64Audio.slice(i, i + CHUNK_SIZE);
                        session.sendRealtimeInput([{ data: chunk, mimeType: 'audio/pcm;rate=16000' }]);
                        // Simulate a natural pace (approx 30ms per chunk)
                        await new Promise(r => setTimeout(r, 20));
                    }
                    console.log("--- [INFO] Audio Stream Complete ---");
                }

                console.log("--- [STEP 4] Injecting Image Frame... ---");
                session.sendRealtimeInput([{ data: base64Image, mimeType: 'image/jpeg' }]);

                console.log("--- [STEP 5] Sending Final Nudge... ---");
                session.sendClientContent({
                    turns: [{ role: 'user', parts: [{ text: "Transcribe that audio clip and describe my screen." }] }],
                    turnComplete: true
                });
            },
            onmessage: (message) => {
                // Filter out the giant binary voice data so we can see the text logic
                console.log("--- [INCOMING] ---", JSON.stringify(message, (k,v) => k === 'data' ? '[BINARY]' : v, 2));
                
                if (message.serverContent?.modelTurn || message.serverContent?.outputTranscription) {
                    console.log("--- [SUCCESS] Content Received! ---");
                    setTimeout(() => process.exit(0), 5000); // Give it time to finish speaking
                }
            },
            onerror: (err) => {
                console.error("--- [SDK ERROR] ---", err);
                process.exit(1);
            },
            onclose: (e) => {
                console.log("--- [SDK CLOSED] ---", e);
            }
        }
    });

    setTimeout(() => { console.log("--- [TIMEOUT] ---"); process.exit(1); }, 60000);
}

runTest().catch(console.error);