package com.agentx.app.service

import android.app.*
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import androidx.core.app.NotificationCompat
import okhttp3.* 
import java.util.concurrent.TimeUnit

class StreamingService : Service() {
    private var mediaProjection: MediaProjection? = null
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
            .url("wss://YOUR_PROJECT_ID.supabase.co/functions/v1/gemini-live-relay")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                // Parse JSON and update Accessibility Overlay
                AgentXAccessibilityService.instance?.updateThought(text)
            }
        })
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
        webSocket?.close(1000, "Service Destroyed")
        mediaProjection?.stop()
        super.onDestroy()
    }
}