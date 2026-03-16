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
        showTapCircle(x, y)
        val path = android.graphics.Path()
        path.moveTo(x.toFloat(), y.toFloat())
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, 100)
        val builder = android.accessibilityservice.GestureDescription.Builder()
        builder.addStroke(stroke)
        dispatchGesture(builder.build(), null, null)
    }

    fun getUiTree(): String {
        val root = rootInActiveWindow ?: return "[]"
        val nodes = mutableListOf<org.json.JSONObject>()
        flattenNodes(root, nodes)
        return org.json.JSONArray(nodes).toString()
    }

    private fun flattenNodes(node: android.view.accessibility.AccessibilityNodeInfo, list: MutableList<org.json.JSONObject>) {
        if (node.isVisibleToUser) {
            val bounds = android.graphics.Rect()
            node.getBoundsInScreen(bounds)
            val obj = org.json.JSONObject().apply {
                put("text", node.text ?: node.contentDescription ?: "")
                put("class", node.className?.split(".")?.last() ?: "")
                put("id", node.viewIdResourceName?.split("/")?.last() ?: "")
                put("clickable", node.isClickable)
                put("bounds", "${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}")
            }
            if (node.isClickable || node.text != null) list.add(obj)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            flattenNodes(child, list)
        }
    }

    private fun showTapCircle(x: Int, y: Int) {
        thoughtText?.post {
            val feedbackView = View(this).apply {
                setBackgroundResource(android.R.drawable.presence_online) // Simple green/red dot
                background.setTint(0xFFFF0000.toInt()) // Bright Red
            }
            val size = 40
            val params = WindowManager.LayoutParams(
                size, size,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                this.x = x - (size / 2)
                this.y = y - (size / 2)
            }
            wm?.addView(feedbackView, params)
            hideHandler.postDelayed({ try { wm?.removeView(feedbackView) } catch(e: Exception) {} }, 800)
        }
    }

    fun performAction(actionId: Int) {
        performGlobalAction(actionId)
    }

    fun tapNodeByQuery(query: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val list = root.findAccessibilityNodeInfosByText(query)
        
        // Try exact text match first, then content description
        val target = list.firstOrNull { it.isVisibleToUser } 
            ?: findNodeByDescription(root, query)

        return if (target != null) {
            val bounds = android.graphics.Rect()
            target.getBoundsInScreen(bounds)
            tap(bounds.centerX(), bounds.centerY())
            true
        } else {
            false
        }
    }

    private fun findNodeByDescription(node: android.view.accessibility.AccessibilityNodeInfo, query: String): android.view.accessibility.AccessibilityNodeInfo? {
        if (node.contentDescription?.toString()?.contains(query, ignoreCase = true) == true) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val result = findNodeByDescription(child, query)
            if (result != null) return result
        }
        return null
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int) {
        val path = android.graphics.Path()
        path.moveTo(x1.toFloat(), y1.toFloat())
        path.lineTo(x2.toFloat(), y2.toFloat())
        
        // 300ms is a standard 'natural' swipe duration
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, 300)
        val builder = android.accessibilityservice.GestureDescription.Builder()
        builder.addStroke(stroke)
        dispatchGesture(builder.build(), null, null)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    
    override fun onDestroy() {
        super.onDestroy()
        if (thoughtText != null) wm?.removeView(thoughtText)
        instance = null
    }
}