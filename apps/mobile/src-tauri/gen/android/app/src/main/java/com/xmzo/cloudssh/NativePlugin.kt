package com.xmzo.cloudssh

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Rust 做不了的系统能力（由 src-tauri/src/native.rs 调用）：
 * 前台服务保活、写入系统“下载”、剪贴板、打开外部链接、退到后台、系统栏配色、电池优化白名单。
 * 参数一律按 JSObject 读取，不走反射反序列化，R8 混淆后也不受影响。
 */
@TauriPlugin
class NativePlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs by lazy { activity.getSharedPreferences("cloudssh", Context.MODE_PRIVATE) }

    @Command
    fun keepAlive(invoke: Invoke) {
        val args = invoke.getArgs()
        val sessions = args.optInt("sessions", 0)
        if (sessions > 0) {
            askNotificationPermissionOnce()
            KeepAliveService.update(activity, sessions, args.optString("title", "CloudSSH"), args.optString("text", ""))
        } else {
            KeepAliveService.stop(activity)
        }
        invoke.resolve()
    }

    /** Android 13+ 的通知权限只主动问一次；拒绝后前台服务照常运行，只是通知栏不显示 */
    private fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
    }

    /** 把 Rust 写好的临时文件存进系统“下载”目录（MediaStore，无需存储权限），返回最终文件名 */
    @Command
    fun saveDownload(invoke: Invoke) {
        val args = invoke.getArgs()
        val source = File(args.getString("path"))
        val name = args.getString("name").ifBlank { "download" }
        val mime = args.getString("mime").ifBlank { "application/octet-stream" }
        if (!source.isFile) {
            invoke.reject("临时文件不存在")
            return
        }
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            invoke.reject("无法在“下载”目录创建文件")
            return
        }
        try {
            resolver.openOutputStream(uri).use { output ->
                requireNotNull(output) { "无法写入下载文件" }
                source.inputStream().use { it.copyTo(output) }
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            // 重名时系统会自动改名（如 a (1).txt），把真实文件名告诉页面
            val finalName = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            } ?: name
            invoke.resolve(JSObject().put("name", finalName))
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            invoke.reject(error.message ?: "保存失败", error)
        } finally {
            source.delete()
        }
    }

    @Command
    fun clipboardRead(invoke: Invoke) {
        activity.runOnUiThread {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString() ?: ""
            invoke.resolve(JSObject().put("text", text))
        }
    }

    @Command
    fun clipboardWrite(invoke: Invoke) {
        val text = invoke.getArgs().optString("text", "")
        activity.runOnUiThread {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("CloudSSH", text))
            invoke.resolve()
        }
    }

    @Command
    fun openUrl(invoke: Invoke) {
        val url = invoke.getArgs().getString("url")
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("没有可以打开链接的应用", error)
        }
    }

    @Command
    fun moveToBackground(invoke: Invoke) {
        activity.runOnUiThread { activity.moveTaskToBack(true) }
        invoke.resolve()
    }

    /** 状态栏/导航栏跟随网页主题：背景色 + 图标深浅 */
    @Command
    fun systemBars(invoke: Invoke) {
        val color = invoke.getArgs().getString("color")
        activity.runOnUiThread {
            (activity as? MainActivity)?.applySystemBarColor(color)
            invoke.resolve()
        }
    }

    /** 设置页显示：应用数据（不含 APK）与其中的缓存 */
    @Command
    fun storageInfo(invoke: Invoke) {
        invoke.resolve(JSObject().put("data", Storage.dataSize(activity)).put("cache", Storage.cacheSize(activity)))
    }

    @Command
    fun clearCache(invoke: Invoke) {
        activity.runOnUiThread {
            (activity as? MainActivity)?.webView?.clearCache(true)
            Thread {
                Storage.clearCacheFiles(activity)
                invoke.resolve(JSObject().put("cache", Storage.cacheSize(activity)))
            }.start()
        }
    }

    @Command
    fun batteryStatus(invoke: Invoke) {
        val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        invoke.resolve(JSObject().put("ignoring", power.isIgnoringBatteryOptimizations(activity.packageName)))
    }

    /** 申请“不受电池优化限制”，长时间后台挂 SSH 时系统更不容易断网/杀进程 */
    @SuppressLint("BatteryLife")
    @Command
    fun requestBatteryExemption(invoke: Invoke) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
        val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        try {
            activity.startActivity(direct)
        } catch (_: Exception) {
            runCatching { activity.startActivity(fallback) }
        }
        invoke.resolve()
    }
}
