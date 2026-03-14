package com.agentx.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object DebugLogManager {
    private val _logs = MutableStateFlow<List<String>>(emptyList())
    val logs = _logs.asStateFlow()

    fun log(tag: String, message: String) {
        val timestamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.getDefault()).format(Date())
        val entry = "[$timestamp] $tag: $message"
        val current = _logs.value.toMutableList()
        if (current.size > 50) current.removeAt(0)
        current.add(entry)
        _logs.value = current
    }

    fun clear() {
        _logs.value = emptyList()
    }

    fun getAllLogs(): String = _logs.value.joinToString("\n")
}