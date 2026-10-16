package com.xmzo.cloudssh

import android.content.Context
import java.io.File

/**
 * 控制应用本体与缓存占用。
 *
 * - WebView 统计埋点：Manifest 已关闭（MetricsOptOut），这里再阻止它生成约 4MB 的预分配文件
 * - 缓存（WebView HTTP 缓存、GitHub 头像、下载临时文件）：超过上限时下次启动整体清空
 *
 * 界面打包在 APK 里，不靠 HTTP 缓存加载，清空缓存不影响离线打开。
 */
object Storage {
    /** 缓存超过这个大小就在下次启动时清空 */
    private const val CACHE_LIMIT_BYTES = 16L * 1024 * 1024

    /** WebView 预分配给下次会话统计用的文件（约 4MB）；关闭埋点也照样会生成 */
    private const val METRICS_SPARE = "BrowserMetrics-spare.pma"
    private const val METRICS_DIR = "BrowserMetrics"

    /** 启动时、创建 WebView 之前调用 */
    fun trimOnStartup(context: Context) {
        val webviewDir = File(context.applicationInfo.dataDir, "app_webview")
        File(webviewDir, METRICS_DIR).deleteRecursively()
        // 用同名空目录占位，WebView 无法再创建这个 4MB 文件（创建失败时它会直接放弃，不影响功能）
        val spare = File(webviewDir, METRICS_SPARE)
        if (spare.isFile) spare.delete()
        if (!spare.exists()) {
            webviewDir.mkdirs()
            spare.mkdir()
        }
        if (cacheSize(context) > CACHE_LIMIT_BYTES) clearCacheFiles(context)
    }

    fun cacheSize(context: Context): Long = sizeOf(context.cacheDir) + sizeOf(context.codeCacheDir)

    /** 应用数据总占用（不含 APK 本身） */
    fun dataSize(context: Context): Long = sizeOf(File(context.applicationInfo.dataDir))

    fun clearCacheFiles(context: Context) {
        context.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    private fun sizeOf(file: File): Long = when {
        !file.exists() -> 0
        file.isFile -> file.length()
        else -> file.listFiles()?.sumOf { sizeOf(it) } ?: 0
    }
}
