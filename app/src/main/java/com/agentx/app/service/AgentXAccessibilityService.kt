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
    private val hideHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val hideRunnable = Runnable { thoughtText?.visibility = View.GONE }

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
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP

        thoughtText = TextView(this).apply {
            // HUD STYLING: Transparent black background, neon green text
            setBackgroundColor(0x99000000.toInt()) 
            setTextColor(0xFF00FF00.toInt())
            textSize = 14f
            setPadding(40, 60, 40, 40)
            text = "AgentX: Ready"
            visibility = View.GONE // Start hidden
        }
        
        wm?.addView(thoughtText, params)
    }

    fun updateThought(newText: String) {
        thoughtText?.post {
            thoughtText?.apply {
                text = newText
                visibility = View.VISIBLE
                hideHandler.removeCallbacks(hideRunnable)
                hideHandler.postDelayed(hideRunnable, 5000)
            }
        }
    }

    fun tap(x: Int, y: Int) {
        val path = android.graphics.Path()
        path.moveTo(x.toFloat(), y.toFloat())
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, 100)
        val builder = android.accessibilityservice.GestureDescription.Builder()
        builder.addStroke(stroke)
        dispatchGesture(builder.build(), null, null)
    }

    fun performAction(actionId: Int) {
        performGlobalAction(actionId)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    
    override fun onDestroy() {
        super.onDestroy()
        if (thoughtText != null) wm?.removeView(thoughtText)
        instance = null
    }
}