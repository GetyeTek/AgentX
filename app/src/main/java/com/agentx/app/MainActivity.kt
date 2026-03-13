package com.agentx.app

import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import android.content.ClipboardManager
import android.content.ClipData
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentx.app.service.StreamingService

class MainActivity : ComponentActivity() {
    
    private val projectionLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK && result.data != null) {
            val intent = Intent(this, StreamingService::class.java).apply {
                putExtra("RESULT_CODE", result.resultCode)
                putExtra("RESULT_DATA", result.data)
            }
            startForegroundService(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var showDebug by remember { mutableStateOf(false) }
            Surface(modifier = Modifier.fillMaxSize()) {
                Column {
                    OnboardingScreen(
                        onStartRequested = { checkPermissionsAndStart() },
                        onDebugRequested = { showDebug = true }
                    )
                }
                if (showDebug) {
                    DebugDialog(onDismiss = { showDebug = false })
                }
            }
        }
    }

    private fun checkPermissionsAndStart() {
        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:\$packageName"))
            startActivity(intent)
            return
        }
        
        // Note: In a production app, you'd check Accessibility Service status here

        val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(mpManager.createScreenCaptureIntent())
    }
}

@Composable
fun OnboardingScreen(onStartRequested: () -> Unit, onDebugRequested: () -> Unit) {
    Column(
        modifier = Modifier.padding(16.dp).fillMaxSize(),
        verticalArrangement = Arrangement.Center
    ) {
        Text("Welcome to AgentX", style = MaterialTheme.typography.headlineMedium)
        Spacer(modifier = Modifier.height(8.dp))
        Text("To begin, AgentX needs to see your screen and draw an overlay to show you its thoughts.")
        Spacer(modifier = Modifier.height(24.dp))
        Button(onClick = onStartRequested, modifier = Modifier.fillMaxWidth()) {
            Text("Grant Permissions & Start")
        }
        Spacer(modifier = Modifier.height(12.dp))
        OutlinedButton(onClick = onDebugRequested, modifier = Modifier.fillMaxWidth()) {
            Text("Open Debug Logs")
        }
    }
}

@Composable
fun DebugDialog(onDismiss: () -> Unit) {
    val logs by DebugLogManager.logs.collectAsState()
    val context = LocalContext.current

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Raw Debug Logs") },
        text = {
            Column {
                Box(
                    modifier = Modifier
                        .height(300.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(8.dp)
                ) {
                    Text(
                        text = if (logs.isEmpty()) "No logs yet..." else logs.joinToString("\n"),
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("AgentX Logs", DebugLogManager.getAllLogs())
                clipboard.setPrimaryClip(clip)
            }) {
                Text("Copy All")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        }
    )
}