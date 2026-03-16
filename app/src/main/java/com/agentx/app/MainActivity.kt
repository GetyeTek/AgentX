package com.agentx.app

import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
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
                putExtra("ENABLE_MIC", savedMicState)
            }
            startForegroundService(intent)
        }
    }

    private var savedMicState = false

        override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        syncInstalledAppsIfNeeded()
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                var showDebug by remember { mutableStateOf(false) }
                var isMicEnabled by remember { mutableStateOf(false) }
                var userCommand by remember { mutableStateOf("") }
                
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(16.dp)
                            .verticalScroll(rememberScrollState())
                    ) {
                        Text("AgentX Controller", style = MaterialTheme.typography.headlineMedium)
                        Spacer(modifier = Modifier.height(20.dp))
                        
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Checkbox(checked = isMicEnabled, onCheckedChange = { isMicEnabled = it })
                            Text("Enable Microphone (Audio + Video)")
                        }

                        Spacer(modifier = Modifier.height(20.dp))
                        
                        Button(
                            onClick = { 
                                savedMicState = isMicEnabled
                                checkPermissionsAndStart(isMicEnabled) 
                            }, 
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("🚀 START AGENT")
                        }
                        
                        Spacer(modifier = Modifier.height(10.dp))
                        
                        Button(
                            onClick = { stopService(Intent(this@MainActivity, StreamingService::class.java)) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                        ) {
                            Text("🛑 STOP AGENT")
                        }

                        Spacer(modifier = Modifier.height(20.dp))
                        
                        OutlinedButton(onClick = { showDebug = true }, modifier = Modifier.fillMaxWidth()) {
                            Text("📜 VIEW RAW LOGS")
                        }

                        Spacer(modifier = Modifier.height(20.dp))
                        Divider()
                        Spacer(modifier = Modifier.height(20.dp))

                        Text("Direct Command", style = MaterialTheme.typography.labelLarge)
                        OutlinedTextField(
                            value = userCommand,
                            onValueChange = { userCommand = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text("e.g. Open the settings app") }
                        )
                        Button(
                            onClick = {
                                val intent = Intent(this@MainActivity, StreamingService::class.java).apply {
                                    putExtra("COMMAND", userCommand)
                                }
                                startForegroundService(intent)
                                userCommand = ""
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = userCommand.isNotBlank()
                        ) {
                            Text("📤 SEND TO AGENT")
                        }
                    }
                    
                    if (showDebug) {
                        DebugDialog(onDismiss = { showDebug = false })
                    }
                }
            }
        }
    }

    private fun checkPermissionsAndStart(micEnabled: Boolean) {
        if (micEnabled && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 102)
            return
        }

        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
            startActivity(intent)
            return
        }

        if (com.agentx.app.service.AgentXAccessibilityService.instance == null) {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            startActivity(intent)
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
                return
            }
        }
        
        val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(mpManager.createScreenCaptureIntent())
    }

    private fun syncInstalledAppsIfNeeded() {
        val prefs = getSharedPreferences("agentx_prefs", Context.MODE_PRIVATE)
        val lastSync = prefs.getLong("last_app_sync", 0)
        val threeDaysMs = 3 * 24 * 60 * 60 * 1000L

        if (System.currentTimeMillis() - lastSync > threeDaysMs) {
            Thread { 
                try {
                    val pm = packageManager
                    val mainIntent = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
                    val apps = pm.queryIntentActivities(mainIntent, 0)
                    
                    val jsonArray = org.json.JSONArray()
                    for (app in apps) {
                        val obj = org.json.JSONObject()
                        obj.put("app_name", app.loadLabel(pm).toString())
                        obj.put("package_name", app.activityInfo.packageName)
                        jsonArray.put(obj)
                    }

                    val client = okhttp3.OkHttpClient()
                    val body = org.json.JSONObject().apply { put("apps", jsonArray) }.toString()
                        .toRequestBody("application/json".toMediaType())
                    
                    val request = okhttp3.Request.Builder()
                        .url("https://xvldfsmxskhemkslsbym.supabase.co/functions/v1/sync-apps")
                        .post(body)
                        .build()

                    client.newCall(request).execute().use {
                        if (it.isSuccessful) {
                            prefs.edit().putLong("last_app_sync", System.currentTimeMillis()).apply()
                            DebugLogManager.log("SYNC", "App directory synced to cloud")
                        }
                    }
                } catch (e: Exception) {
                    DebugLogManager.log("SYNC_ERR", e.message ?: "Unknown error")
                }
            }.start()
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
            Row {
                TextButton(onClick = { DebugLogManager.clear() }) {
                    Text("Clear", color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClick = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val clip = ClipData.newPlainText("AgentX Logs", DebugLogManager.getAllLogs())
                    clipboard.setPrimaryClip(clip)
                }) {
                    Text("Copy All")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        }
    )
}