package com.agentx.app.service

import android.accessibilityservice.AccessibilityService
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.TextView
import com.agentx.app.R

class AgentXAccessibilityService : AccessibilityService() {
    private var overlayView: View? = null
    private var wm: WindowManager? = null
    private var thoughtText: TextView? = null

    companion object {
        var instance: AgentXAccessibilityService? = null
    }

    override fun onServiceConnected() {
        instance = this
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        setupOverlay()
    }

    private fun setupOverlay() {
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP

        // Basic overlay layout - using a simple TextView programmatically for now
        thoughtText = TextView(this).apply {
            // HUD STYLING
            setBackgroundResource(android.R.drawable.toast_frame)
            backgroundTintList = android.content.res.ColorStateList.valueOf(0xCC000000.toInt())
            setTextColor(0xFF00FF00.toInt()) // Sci-fi Green
            textSize = 14f
            setPadding(30, 30, 30, 30)
            text = "AgentX: Initializing..."
        }
        
        wm?.addView(thoughtText, params)
    }

    fun updateThought(text: String) {
        thoughtText?.post { thoughtText?.text = text }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    
    override fun onDestroy() {
        super.onDestroy()
        if (thoughtText != null) wm?.removeView(thoughtText)
        instance = null
    }
}