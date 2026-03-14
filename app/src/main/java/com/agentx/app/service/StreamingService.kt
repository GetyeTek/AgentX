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
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONArray

class StreamingService : Service() {
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra("RESULT_CODE", 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>("RESULT_DATA")

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
                try {
                    val json = JSONObject(text)
                    
                    // WATERFALL: Support both snake_case and CamelCase from Google
                    val serverContent = json.optJSONObject("server_content") ?: json.optJSONObject("serverContent")
                    val modelTurn = serverContent?.optJSONObject("model_turn") ?: serverContent?.optJSONObject("modelTurn")
                    val parts = modelTurn?.optJSONArray("parts")
                    
                    // Check for standard text output OR transcriptions
                    val textPart = parts?.optJSONObject(0)?.optString("text")
                    val transcription = serverContent?.optJSONObject("output_transcription")?.optString("text")
                        ?: serverContent?.optJSONObject("outputTranscription")?.optString("text")

                    val thought = textPart ?: transcription
                    
                    if (!thought.isNullOrEmpty()) {
                        DebugLogManager.log("AI_THOUGHT", thought)
                        // Update the floating overlay
                        AgentXAccessibilityService.instance?.updateThought("AgentX: $thought")
                    }
                } catch (e: Exception) {
                    // Usually just binary audio frames failing to parse as JSON, which is fine.
                }
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
        
        // Scale down for AI processing (efficiency)
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

        handler?.post(object : Runnable {
            override fun run() {
                captureAndSendFrame()
                handler?.postDelayed(this, 1500) // ~1 frame every 1.5 seconds
            }
        })
    }

    private fun captureAndSendFrame() {
        val image = imageReader?.acquireLatestImage() ?: return
        try {
            val planes = image.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * image.width

            val bitmap = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height, Bitmap.Config.ARGB_8888
            )
            bitmap.copyPixelsFromBuffer(buffer)

            val out = ByteArrayOutputStream()
            // Dropped to 50 for speed. Gemini doesn't need 4K to see a button.
            bitmap.compress(Bitmap.CompressFormat.JPEG, 50, out)
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

            bitmap.recycle()
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
        handlerThread?.quitSafely()
        virtualDisplay?.release()
        imageReader?.close()
        webSocket?.close(1000, "Service Destroyed")
        mediaProjection?.stop()
        super.onDestroy()
    }
}