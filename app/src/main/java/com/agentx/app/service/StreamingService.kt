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
    private var isMicEnabled = false
    private var lastActionTime = 0L
    
    @Volatile
    private var isRunning = true

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val commandReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val cmd = intent?.getStringExtra("COMMAND") ?: return
            sendUserText(cmd)
        }
    }

    override fun onCreate() {
        super.onCreate()
        registerReceiver(commandReceiver, android.content.IntentFilter("com.agentx.app.SEND_COMMAND"), RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val cmd = intent?.getStringExtra("COMMAND")
        if (cmd != null) {
            runBrainCycle(cmd)
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra("RESULT_CODE", 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>("RESULT_DATA")
        isMicEnabled = intent?.getBooleanExtra("ENABLE_MIC", false) ?: false

        startForeground(1, createNotification())

        if (resultData != null) {
            AgentXAccessibilityService.instance?.updateThought("AgentX: Connecting...")
            val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = mpManager.getMediaProjection(resultCode, resultData)
            connectWebSocket()
        }

        return START_NOT_STICKY
    }

    private fun runBrainCycle(userPrompt: String) {
        lastUserCommand = userPrompt
        Thread {
            val imageBase64 = captureCurrentFrameBase64() ?: return@Thread
            val uiTree = AgentXAccessibilityService.instance?.getUiTree() ?: "[]"
            
            val json = JSONObject().apply {
                put("image", imageBase64)
                put("tree", uiTree)
                put("prompt", userPrompt)
            }

            val body = RequestBody.create(MediaType.parse("application/json"), json.toString())
            val request = Request.Builder()
                .url("https://xvldfsmxskhemkslsbym.supabase.co/functions/v1/agent-brain")
                .post(body)
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    val respData = response.body()?.string() ?: ""
                    processBrainResponse(respData)
                }
            } catch (e: Exception) {
                DebugLogManager.log("BRAIN_ERR", e.message ?: "Unknown error")
            }
        }.start()
    }

    private fun captureCurrentFrameBase64(): String? {
        val image = imageReader?.acquireLatestImage() ?: return null
        try {
            val planes = image.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val fullBitmap = Bitmap.createBitmap(image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888)
            fullBitmap.copyPixelsFromBuffer(buffer)
            val out = ByteArrayOutputStream()
            Bitmap.createBitmap(fullBitmap, 0, 0, image.width, image.height).compress(Bitmap.CompressFormat.JPEG, 70, out)
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally { image.close() }
    }

    private fun processBrainResponse(raw: String) {
        val json = JSONObject(raw)
        val candidates = json.optJSONArray("candidates")?.optJSONObject(0)
        val content = candidates?.optJSONObject("content")
        val parts = content?.optJSONArray("parts")
        val call = parts?.optJSONObject(0)?.optJSONObject("function_call")
        val textResponse = parts?.optJSONObject(0)?.optString("text", "") ?: ""

        if (textResponse.isNotEmpty()) {
            AgentXAccessibilityService.instance?.updateThought(textResponse)
            DebugLogManager.log("AI_SAYS", textResponse)
        }

        if (call != null) {
            val name = call.getString("name")
            val args = call.optJSONObject("args")
            val a11y = AgentXAccessibilityService.instance
            
            var waitTime = 2000L
            when (name) {
                "tap_coords" -> {
                    val scale = getSystemService(WindowManager::class.java).defaultDisplay.width / 1024f
                    a11y?.tap((args.getInt("x") * scale).toInt(), (args.getInt("y") * scale).toInt())
                }
                "swipe" -> {
                    val metrics = resources.displayMetrics
                    val w = metrics.widthPixels
                    val h = metrics.heightPixels
                    when(args.getString("direction")) {
                        "up" -> a11y?.swipe(w/2, h*3/4, w/2, h/4)
                        "down" -> a11y?.swipe(w/2, h/4, w/2, h*3/4)
                        "left" -> a11y?.swipe(w*3/4, h/2, w/4, h/2)
                        "right" -> a11y?.swipe(w/4, h/2, w*3/4, h/2)
                    }
                }
                "home" -> a11y?.performAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME)
                "back" -> a11y?.performAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                "recents" -> a11y?.performAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS)
                "wait" -> waitTime = args.optLong("seconds", 2) * 1000L
            }
            
            DebugLogManager.log("ACTION", "Executed $name, waiting ${waitTime}ms...")
            Thread.sleep(waitTime)
            // Continuous Autonomy: Re-trigger the brain cycle using the same initial goal prompt
            // This allows the AI to keep 'looking' until it explicitly stops using text.
            runBrainCycle(lastUserCommand)
        } else if (textResponse.startsWith("DONE:")) {
            DebugLogManager.log("SYSTEM", "Task Completed.")
        } else {
            // If the AI just spoke but didn't act or finish, look again after a short delay
            Thread.sleep(3000)
            runBrainCycle(lastUserCommand)
        }
    }

    private var lastUserCommand: String = ""

    private fun startCaptureLoop() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(metrics)
        
        val width = 1024
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
                if (!isRunning) return
                
                // Only send frame if we haven't acted in the last 2 seconds
                // This prevents the AI from seeing 'stale' or 'transitioning' screens
                if (System.currentTimeMillis() - lastActionTime > 2000) {
                    captureAndSendFrame()
                }
                
                handler?.postDelayed(this, 1000)
            }
        })

        if (isMicEnabled) {
            Thread { startAudioCapture() }.start()
        }
    }

    private fun startAudioCapture() {
        val bufferSize = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
        val buffer = ByteArray(3200)
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
        speechBuffer.setLength(0)
        val image = imageReader?.acquireLatestImage() ?: return
        try {
            val planes = image.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * image.width

            val fullBitmap = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height, Bitmap.Config.ARGB_8888
            )
            fullBitmap.copyPixelsFromBuffer(buffer)
            val cleanBitmap = Bitmap.createBitmap(fullBitmap, 0, 0, image.width, image.height)

            val out = ByteArrayOutputStream()
            cleanBitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
            val base64Image = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)

            val payload = JSONObject().apply {
                put("client_content", JSONObject().apply {
                    put("turns", JSONArray().apply {
                        put(JSONObject().apply {
                            put("role", "user")
                            put("parts", JSONArray().apply {
                                put(JSONObject().apply {
                                    put("inline_data", JSONObject().apply {
                                        put("mime_type", "image/jpeg")
                                        put("data", base64Image)
                                    })
                                })
                                put(JSONObject().apply { put("text", ".") })
                            })
                        })
                    })
                    put("turn_complete", true)
                })
            }
            webSocket?.send(payload.toString())

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

    private fun sendUserText(text: String) {
        val payload = JSONObject().apply {
            put("client_content", JSONObject().apply {
                put("turns", JSONArray().apply {
                    put(JSONObject().apply {
                        put("role", "user")
                        put("parts", JSONArray().apply {
                            put(JSONObject().apply { put("text", text) })
                        })
                    })
                })
                put("turn_complete", true)
            })
        }
        webSocket?.send(payload.toString())
        DebugLogManager.log("USER", text)
    }

    override fun onDestroy() {
        try { unregisterReceiver(commandReceiver) } catch (e: Exception) {}
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
