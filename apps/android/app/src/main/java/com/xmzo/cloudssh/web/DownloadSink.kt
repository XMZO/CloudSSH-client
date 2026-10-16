package com.xmzo.cloudssh.web

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import java.io.OutputStream

/**
 * 把网页里的 blob 下载写进系统“下载”目录（MediaStore，Android 10+ 无需存储权限）。
 * 写入期间标记 IS_PENDING，完成后才对其他应用可见；中途失败会删除半截文件。
 */
class DownloadSink(private val context: Context) {
    private class Active(val uri: Uri, val stream: OutputStream, val name: String, var written: Long = 0)

    private val active = mutableMapOf<Int, Active>()
    private var nextId = 1

    fun begin(rawName: String, mime: String): Int {
        val name = sanitize(rawName)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("无法创建下载文件")
        val stream = resolver.openOutputStream(uri) ?: run {
            resolver.delete(uri, null, null)
            throw IllegalStateException("无法写入下载文件")
        }
        val id = nextId++
        active[id] = Active(uri, stream, name)
        return id
    }

    fun append(id: Int, bytes: ByteArray) {
        val entry = active[id] ?: throw IllegalStateException("下载不存在或已结束")
        entry.stream.write(bytes)
        entry.written += bytes.size
    }

    /** 完成并返回最终文件名 */
    fun finish(id: Int): String {
        val entry = active.remove(id) ?: throw IllegalStateException("下载不存在或已结束")
        entry.stream.close()
        val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
        context.contentResolver.update(entry.uri, values, null, null)
        return entry.name
    }

    fun abort(id: Int) {
        val entry = active.remove(id) ?: return
        runCatching { entry.stream.close() }
        runCatching { context.contentResolver.delete(entry.uri, null, null) }
    }

    fun abortAll() {
        active.keys.toList().forEach(::abort)
    }

    companion object {
        /** 去掉路径分隔符与控制字符；开头的点会让文件在多数文件管理器里隐藏，一并去掉 */
        fun sanitize(raw: String): String {
            val cleaned = raw.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trimStart('.')
            return cleaned.take(200).ifBlank { "download" }
        }
    }
}
