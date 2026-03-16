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
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.agentx.app.DebugLogManager
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONArray
import android.os.Build

class StreamingService : Service() {
    private var mediaProjection: MediaProjection? = null
    private val isActive = java.util.concurrent.atomic.AtomicBoolean(false)
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var lastUserCommand: String = ""
    private val actionHistory = mutableListOf<String>()
    
    private val client = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val cmd = intent?.getStringExtra("COMMAND")
        if (cmd != null) {
            lastUserCommand = cmd
            actionHistory.clear() // Reset history for new command
            runBrainCycle(cmd)
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra("RESULT_CODE", 0) ?: 0
        val resultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra("RESULT_DATA", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra("RESULT_DATA")
        }

        startForeground(1, createNotification())
        isActive.set(true)

        if (resultData != null) {
            val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = mpManager.getMediaProjection(resultCode, resultData)
            setupImageReader()
            AgentXAccessibilityService.instance?.updateThought("AgentX: Online & Ready")
        }

        return START_NOT_STICKY
    }

    private fun setupImageReader() {
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
    }

    private fun runBrainCycle(userPrompt: String) {
        if (!isActive.get()) return
        Thread {
            DebugLogManager.log("BRAIN", "Starting Cycle: $userPrompt")
            val imageBase64 = captureCurrentFrameBase64()
            if (imageBase64 == null) {
                DebugLogManager.log("ERR", "Failed to capture screen")
                return@Thread
            }
            
            val uiTree = AgentXAccessibilityService.instance?.getUiTree() ?: "[]"
            
            val json = JSONObject().apply {
                put("image", imageBase64)
                put("tree", uiTree)
                put("prompt", userPrompt)
                put("history", JSONArray(actionHistory))
            }

            val mediaType = "application/json".toMediaType()
            val body = json.toString().toRequestBody(mediaType)
            val request = Request.Builder()
                .url("https://xvldfsmxskhemkslsbym.supabase.co/functions/v1/agent-brain")
                .post(body)
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    val respData = response.body?.string() ?: ""
                    processBrainResponse(respData)
                }
            } catch (e: Exception) {
                DebugLogManager.log("BRAIN_ERR", e.message ?: "Unknown error")
            }
        }.start()
    }

    private fun captureCurrentFrameBase64(): String? {
        // Try multiple times to get a fresh image from the reader
        var image = imageReader?.acquireLatestImage()
        if (image == null) {
            Thread.sleep(100)
            image = imageReader?.acquireLatestImage()
        }
        
        return image?.use { img ->
            val planes = img.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * img.width
            val fullBitmap = Bitmap.createBitmap(img.width + rowPadding / pixelStride, img.height, Bitmap.Config.ARGB_8888)
            fullBitmap.copyPixelsFromBuffer(buffer)
            val out = ByteArrayOutputStream()
            Bitmap.createBitmap(fullBitmap, 0, 0, img.width, img.height).compress(Bitmap.CompressFormat.JPEG, 70, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
    }

    private fun processBrainResponse(raw: String) {
        try {
            DebugLogManager.log("RAW_JSON", raw)
            val json = JSONObject(raw)

            // Handle Macro Execution
            if (json.optBoolean("macro_execution", false)) {
                val steps = json.getJSONArray("steps")
                val desc = json.optString("text", "Executing Shortcut...")
                AgentXAccessibilityService.instance?.updateThought(desc)
                
                Thread { 
                    for (i in 0 until steps.length()) {
                        val step = steps.getJSONObject(i)
                        val name = step.keys().next()
                        val args = step.getJSONObject(name)
                        executeTool(name, args)
                        // Note: executeTool calls runBrainCycle at the end. 
                        // For macros, we need to prevent that until the LAST step.
                        if (i < steps.length() - 1) Thread.sleep(1000)
                    }
                }.start()
                return
            }
            
            if (json.has("error")) {
                DebugLogManager.log("GOOGLE_ERR", json.getJSONObject("error").getString("message"))
                return
            }

            val candidates = json.optJSONArray("candidates")?.optJSONObject(0)
            val content = candidates?.optJSONObject("content")
            val parts = content?.optJSONArray("parts") ?: JSONArray()
            
            var textResponse = ""
            var call: JSONObject? = null

            // Loop through all parts to find text and function calls
            for (i in 0 until parts.length()) {
                val part = parts.getJSONObject(i)
                if (part.has("text")) textResponse += part.getString("text")
                
                // Gemini 3 uses CamelCase 'functionCall'
                if (part.has("functionCall")) call = part.getJSONObject("functionCall")
                else if (part.has("function_call")) call = part.getJSONObject("function_call")
            }

            if (textResponse.isNotEmpty()) {
                // Clean up the response: remove technical prefixes if AI includes them
                val displayThought = textResponse.replace("Thought:", "").replace("THOUGHT:", "").trim()
                AgentXAccessibilityService.instance?.updateThought("AgentX: $displayThought")
                DebugLogManager.log("AI_THOUGHT", displayThought)
            }

            if (call != null) {
                val name = call.getString("name")
                val args = call.optJSONObject("args") ?: JSONObject()
                executeTool(name, args)
            } else {
                if (textResponse.startsWith("DONE:")) {
                    DebugLogManager.log("SYSTEM", "Task Finished")
                } else {
                    DebugLogManager.log("SYSTEM", "No action found, re-observing...")
                    Thread.sleep(3000)
                    runBrainCycle(lastUserCommand)
                }
            }
        } catch (e: Exception) {
            DebugLogManager.log("PARSE_ERR", "${e.message}")
        }
    }

    private fun executeTool(name: String, args: JSONObject) {
        val a11y = AgentXAccessibilityService.instance
        var waitTime = 2000L

        when (name) {
            "tap_coords" -> {
                val scale = getSystemService(WindowManager::class.java).defaultDisplay.width / 1024f
                a11y?.tap((args.getInt("x") * scale).toInt(), (args.getInt("y") * scale).toInt())
            }
            "tap_node" -> {
                val query = args.optString("query", "")
                val success = a11y?.tapNodeByQuery(query) ?: false
                if (!success) DebugLogManager.log("A11Y", "Could not find node: $query")
            }
            "swipe" -> {
                val metrics = resources.displayMetrics
                val w = metrics.widthPixels
                val h = metrics.heightPixels
                when(args.optString("direction")) {
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
            "open_app" -> {
                val name = args.optString("name")
                val success = a11y?.launchAppByName(name) ?: false
                if (!success) DebugLogManager.log("APP_LAUNCH", "Failed to find app: $name")
                waitTime = 3000L
            }
            "type_text" -> {
                val query = args.optString("query", null)
                val text = args.optString("text", "")
                val success = a11y?.typeText(query, text) ?: false
                if (!success) DebugLogManager.log("A11Y", "Failed to type text into: $query")
                waitTime = 1500L
            }
            "save_macro" -> {
                // This tool is purely for the Edge Function to handle Database persistence.
                // We log it here for debugging.
                DebugLogManager.log("SYSTEM", "AI saved a new macro: ${args.optString("intent")}")
                waitTime = 500L
            }
        }

        val actionSummary = "Executed $name with args $args"
        actionHistory.add(actionSummary)
        if (actionHistory.size > 10) actionHistory.removeAt(0)

        DebugLogManager.log("ACTION", "$actionSummary. Sleeping ${waitTime}ms...")
        Thread.sleep(waitTime)
        if (isActive.get()) {
            runBrainCycle(lastUserCommand)
        }
    }

    private fun createNotification(): Notification {
        val channelId = "agentx_service"
        val channel = NotificationChannel(channelId, "AgentX Active", NotificationManager.IMPORTANCE_LOW)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("AgentX Autonomous Mode")
            .setContentText("AI is monitoring and controlling device")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isActive.set(false)
        virtualDisplay?.release()
        imageReader?.close()
        mediaProjection?.stop()
        AgentXAccessibilityService.instance?.updateThought("AgentX: Offline")
        super.onDestroy()
    }
}
