package com.xmzo.cloudssh.web

import android.content.Context
import java.io.File

/**
 * 控制应用本体与缓存占用。
 *
 * - WebView 统计埋点：Manifest 已关闭（MetricsOptOut），这里再删掉旧版本留下的 4MB 预分配文件
 * - HTTP 缓存（主要是 Worker 约 2MB 的内联页面、字体、头像）：超过上限时整体清空
 *
 * cacheDir 本来就是“系统随时可以清空”的目录，WebView 必须容忍其内容消失；
 * 但为稳妥起见，自动清理只在本进程还没创建任何 WebView 时进行。
 */
object StorageTrimmer {
    /** 缓存超过这个大小就在下次启动时清空 */
    const val CACHE_LIMIT_BYTES = 16L * 1024 * 1024

    /** WebView 预分配给下次会话统计用的文件（约 4MB）；关闭埋点也照样会生成 */
    private const val METRICS_SPARE = "BrowserMetrics-spare.pma"
    private const val METRICS_DIR = "BrowserMetrics"

    @Volatile
    private var webViewCreated = false

    fun markWebViewCreated() {
        webViewCreated = true
    }

    /** 启动时调用（在创建 WebView 之前） */
    fun trimOnStartup(context: Context) {
        if (webViewCreated) return
        val webviewDir = File(context.applicationInfo.dataDir, "app_webview")
        File(webviewDir, METRICS_DIR).deleteRecursively()
        // 用同名空目录占位，WebView 无法再创建这个 4MB 文件（创建失败时它会直接放弃，不影响功能）
        val spare = File(webviewDir, METRICS_SPARE)
        if (spare.isFile) spare.delete()
        if (!spare.exists()) {
            webviewDir.mkdirs()
            spare.mkdir()
        }
        if (cacheSize(context) > CACHE_LIMIT_BYTES) clearCacheDir(context)
    }

    fun cacheSize(context: Context): Long = sizeOf(context.cacheDir) + sizeOf(context.codeCacheDir)

    /** 应用数据总占用（不含 APK 本身） */
    fun dataSize(context: Context): Long = sizeOf(File(context.applicationInfo.dataDir))

    fun clearCacheDir(context: Context) {
        context.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    private fun sizeOf(file: File): Long = when {
        !file.exists() -> 0
        file.isFile -> file.length()
        else -> file.listFiles()?.sumOf { sizeOf(it) } ?: 0
    }

    fun format(bytes: Long): String = when {
        bytes >= 1024 * 1024 -> String.format("%.1f MB", bytes / 1024.0 / 1024.0)
        bytes >= 1024 -> String.format("%d KB", bytes / 1024)
        else -> "$bytes B"
    }
}
