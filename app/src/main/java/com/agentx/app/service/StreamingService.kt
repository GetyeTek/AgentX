package com.agentx.app.service

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.agentx.app.DebugLogManager
import okhttp3.*
import okio.ByteString
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONArray

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

class StreamingService : Service() {
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null
    private var webSocket: WebSocket? = null
    private var isMicEnabled = false
    private val thoughtBuffer = StringBuilder()
    
    @Volatile
    private var isRunning = true

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra("RESULT_CODE", 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>("RESULT_DATA")
        isMicEnabled = intent?.getBooleanExtra("ENABLE_MIC", false) ?: false

        startForeground(1, createNotification())

        if (resultData != null) {
            val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = mpManager.getMediaProjection(resultCode, resultData)
            connectWebSocket()
        }

        return START_NOT_STICKY
    }

    private fun connectWebSocket() {
        val request = Request.Builder()
            .url("wss://xvldfsmxskhemkslsbym.supabase.co/functions/v1/gemini-live-relay")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                DebugLogManager.log("WS", "Connected to Supabase Edge Function: ${response.code}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // LOG EVERYTHING RAW
                DebugLogManager.log("RAW_GEMINI", text)
                
                try {
                    val json = JSONObject(text)
                    val serverContent = json.optJSONObject("server_content") ?: json.optJSONObject("serverContent")
                    val modelTurn = serverContent?.optJSONObject("model_turn") ?: serverContent?.optJSONObject("modelTurn")
                    val parts = modelTurn?.optJSONArray("parts")
                    
                    val textPart = parts?.optJSONObject(0)?.optString("text")
                    val transcription = serverContent?.optJSONObject("output_transcription")?.optString("text")
                        ?: serverContent?.optJSONObject("outputTranscription")?.optString("text")

                    // Accumulate or show latest thought
                    val thought = textPart ?: transcription
                    
                    if (!thought.isNullOrEmpty()) {
                        // Accumulate thoughts for the HUD
                        thoughtBuffer.append(thought)
                        val fullThought = thoughtBuffer.toString().trim()

                        DebugLogManager.log("GEMINI", thought)
                        
                        val service = AgentXAccessibilityService.instance
                        if (service != null) {
                            service.updateThought("🧠 $fullThought")
                        } else {
                            DebugLogManager.log("HUD_ERROR", "Accessibility Service not running!")
                        }
                    }
                } catch (e: Exception) {}
            }

            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                DebugLogManager.log("RAW_AUDIO", "Received ${bytes.size} audio bytes")
                // Future: Add AudioTrack here to play AI voice
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val errorBody = response?.body?.string() ?: "No response body"
                DebugLogManager.log("WS_FAILURE", "Error: ${t.message} | Code: ${response?.code} | Body: $errorBody")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                DebugLogManager.log("WS_CLOSE", "Closing: $code / $reason")
            }
        })
        
        startCaptureLoop()
    }

    private fun startCaptureLoop() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(metrics)
        
        val width = 720
        val height = (metrics.heightPixels.toFloat() / metrics.widthPixels * width).toInt()

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "AgentXCapture", width, height, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface, null, null
        )

        handlerThread = HandlerThread("CaptureThread").apply { start() }
        handler = Handler(handlerThread!!.looper)

        // 1. VIDEO LOOP
        handler?.post(object : Runnable {
            override fun run() {
                if (!isRunning) return
                captureAndSendFrame()
                handler?.postDelayed(this, 1500)
            }
        })

        // 2. AUDIO LOOP (If enabled)
        if (isMicEnabled) {
            Thread { startAudioCapture() }.start()
        }
    }

    private fun startAudioCapture() {
        val bufferSize = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
        
        val buffer = ByteArray(3200) // 100ms chunks
        recorder.startRecording()
        
        while (isRunning) {
            val read = recorder.read(buffer, 0, buffer.size)
            if (read > 0) {
                val base64Audio = Base64.encodeToString(buffer.sliceArray(0 until read), Base64.NO_WRAP)
                val payload = JSONObject().apply {
                    put("realtime_input", JSONObject().apply {
                        put("media_chunks", JSONArray().apply {
                            put(JSONObject().apply {
                                put("mime_type", "audio/pcm;rate=16000")
                                put("data", base64Audio)
                            })
                        })
                    })
                }
                webSocket?.send(payload.toString())
            }
        }
        recorder.stop()
        recorder.release()
    }

    private fun captureAndSendFrame() {
        // Clear previous thoughts when a new frame is sent
        thoughtBuffer.setLength(0)
        
        val image = imageReader?.acquireLatestImage() ?: return
        try {
            val planes = image.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * image.width

            // Create bitmap with correct padding
            val fullBitmap = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height, Bitmap.Config.ARGB_8888
            )
            fullBitmap.copyPixelsFromBuffer(buffer)

            // Crop the bitmap to remove padding artifacts
            val cleanBitmap = Bitmap.createBitmap(fullBitmap, 0, 0, image.width, image.height)

            val out = ByteArrayOutputStream()
            cleanBitmap.compress(Bitmap.CompressFormat.JPEG, 50, out)
            val base64Image = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)

            // 1. Send the visual data
            val imagePayload = JSONObject().apply {
                put("realtime_input", JSONObject().apply {
                    put("media_chunks", JSONArray().apply {
                        put(JSONObject().apply {
                            put("mime_type", "image/jpeg")
                            put("data", base64Image)
                        })
                    })
                })
            }
            webSocket?.send(imagePayload.toString())

            // 2. THE NUDGE: Explicitly tell Gemini to look and talk now
            val nudge = JSONObject().apply {
                put("client_content", JSONObject().apply {
                    put("turns", JSONArray().apply {
                        put(JSONObject().apply {
                            put("role", "user")
                            put("parts", JSONArray().apply {
                                put(JSONObject().apply { put("text", "Analyze this screen.") })
                            })
                        })
                    })
                    put("turn_complete", true)
                })
            }
            webSocket?.send(nudge.toString())

            // Clean up both bitmaps to prevent memory leaks
            fullBitmap.recycle()
            cleanBitmap.recycle()
        } catch (e: Exception) {
            DebugLogManager.log("CAPTURE_ERR", "${e.message}")
        } finally {
            image.close()
        }
    }

    private fun createNotification(): Notification {
        val channelId = "streaming_channel"
        val channel = NotificationChannel(channelId, "AgentX Streaming", NotificationManager.IMPORTANCE_LOW)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("AgentX is Active")
            .setContentText("Streaming screen to AI")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        handlerThread?.quitSafely()
        virtualDisplay?.release()
        imageReader?.close()
        webSocket?.close(1000, "Service Stopped")
        mediaProjection?.stop()
        AgentXAccessibilityService.instance?.updateThought("AgentX: Offline")
        super.onDestroy()
    }
}