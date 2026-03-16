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
        path.lineTo(x.toFloat(), y.toFloat()) // Tiny line to ensure registration
        
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, 100)
        val builder = android.accessibilityservice.GestureDescription.Builder()
        builder.addStroke(stroke)
        
        dispatchGesture(builder.build(), object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: android.accessibilityservice.GestureDescription?) {
                com.agentx.app.DebugLogManager.log("GESTURE", "Tap completed at $x, $y")
            }
            override fun onCancelled(gestureDescription: android.accessibilityservice.GestureDescription?) {
                com.agentx.app.DebugLogManager.log("GESTURE", "Tap CANCELLED at $x, $y")
            }
        }, null)
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
                val shape = android.graphics.drawable.GradientDrawable()
                shape.shape = android.graphics.drawable.GradientDrawable.OVAL
                shape.setColor(0x88FF0000.toInt()) // Semi-transparent Red
                shape.setStroke(5, 0xFFFF0000.toInt()) // Solid Red border
                background = shape
            }
            val size = 80
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
            try {
                wm?.addView(feedbackView, params)
                hideHandler.postDelayed({ try { wm?.removeView(feedbackView) } catch(e: Exception) {} }, 600)
            } catch (e: Exception) {}
        }
    }

    private fun showSwipeLine(x1: Int, y1: Int, x2: Int, y2: Int) {
        thoughtText?.post {
            val feedbackView = object : View(this) {
                val paint = android.graphics.Paint().apply {
                    color = 0xAA0000FF.toInt() // Blue
                    strokeWidth = 15f
                    style = android.graphics.Paint.Style.STROKE
                    strokeCap = android.graphics.Paint.Cap.ROUND
                    isAntiAlias = true
                }
                override fun onDraw(canvas: android.graphics.Canvas) {
                    canvas.drawLine(x1.toFloat(), y1.toFloat(), x2.toFloat(), y2.toFloat(), paint)
                }
            }

            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                PixelFormat.TRANSLUCENT
            )
            
            try {
                wm?.addView(feedbackView, params)
                hideHandler.postDelayed({ try { wm?.removeView(feedbackView) } catch(e: Exception) {} }, 1000)
            } catch (e: Exception) {}
        }
    }

    fun performAction(actionId: Int) {
        performGlobalAction(actionId)
    }

    fun launchAppByName(appName: String): Boolean {
        val pm = packageManager
        val mainIntent = android.content.Intent(android.content.Intent.ACTION_MAIN, null)
        mainIntent.addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        
        val apps = pm.queryIntentActivities(mainIntent, 0)
        
        // 1. Try Exact Match
        var target = apps.find { it.loadLabel(pm).toString().equals(appName, ignoreCase = true) }
        
        // 2. Try Fuzzy (Contains)
        if (target == null) {
            target = apps.find { it.loadLabel(pm).toString().contains(appName, ignoreCase = true) }
        }

        return if (target != null) {
            val launchIntent = pm.getLaunchIntentForPackage(target.activityInfo.packageName)
            if (launchIntent != null) {
                launchIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(launchIntent)
                true
            } else false
        } else {
            false
        }
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
        showSwipeLine(x1, y1, x2, y2)
        val path = android.graphics.Path()
        path.moveTo(x1.toFloat(), y1.toFloat())
        path.lineTo(x2.toFloat(), y2.toFloat())
        
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, 400)
        val builder = android.accessibilityservice.GestureDescription.Builder()
        builder.addStroke(stroke)
        
        dispatchGesture(builder.build(), object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: android.accessibilityservice.GestureDescription?) {
                com.agentx.app.DebugLogManager.log("GESTURE", "Swipe completed from $x1,$y1 to $x2,$y2")
            }
        }, null)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    
    override fun onDestroy() {
        super.onDestroy()
        if (thoughtText != null) wm?.removeView(thoughtText)
        instance = null
    }
}