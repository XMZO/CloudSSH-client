package com.xmzo.cloudssh.web

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import com.xmzo.cloudssh.BuildConfig
import com.xmzo.cloudssh.R
import com.xmzo.cloudssh.config.Instance
import com.xmzo.cloudssh.config.InstanceRules
import org.json.JSONObject

/**
 * 页面 ↔ 原生桥接（androidx.webkit WebMessageListener）。
 * 只对实例 origin 注册（allowedOriginRules），并再次校验 sourceOrigin 与主框架，
 * 所以 GitHub 登录页等第三方页面无法调用。协议见 assets/bridge.js。
 */
class WebBridge(
    private val context: Context,
    private val instance: Instance,
    private val onOpenManager: () -> Unit,
) : WebViewCompat.WebMessageListener {

    private val downloads = DownloadSink(context)

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame || !InstanceRules.isSameOrigin(sourceOrigin.toString(), instance.baseUrl)) return
        val request = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        val id = request.optInt("id")
        try {
            val result: Any? = handle(request)
            replyProxy.postMessage(JSONObject().put("id", id).put("ok", true).put("result", result ?: JSONObject.NULL).toString())
        } catch (e: Exception) {
            Log.w(TAG, "bridge ${request.optString("type")} failed", e)
            replyProxy.postMessage(JSONObject().put("id", id).put("ok", false).put("error", e.message ?: "error").toString())
        }
    }

    private fun handle(request: JSONObject): Any? = when (request.optString("type")) {
        "info" -> JSONObject()
            .put("platform", "android")
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("instance", JSONObject().put("id", instance.id).put("name", instance.name).put("baseUrl", instance.baseUrl))
        "open-manager" -> {
            onOpenManager()
            null
        }
        "download-begin" -> downloads.begin(request.optString("name"), request.optString("mime"))
        "download-chunk" -> {
            downloads.append(request.getInt("download"), Base64.decode(request.getString("data"), Base64.DEFAULT))
            null
        }
        "download-end" -> {
            val name = downloads.finish(request.getInt("download"))
            Toast.makeText(context, context.getString(R.string.download_saved, name), Toast.LENGTH_SHORT).show()
            name
        }
        "download-abort" -> {
            downloads.abort(request.getInt("download"))
            null
        }
        "clipboard-read" -> {
            val clip = clipboard().primaryClip
            if (clip == null || clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(context).toString()
        }
        "clipboard-write" -> {
            clipboard().setPrimaryClip(ClipData.newPlainText("CloudSSH", request.optString("text")))
            null
        }
        else -> throw IllegalArgumentException("unknown request: ${request.optString("type")}")
    }

    private fun clipboard() = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    fun dispose() = downloads.abortAll()

    companion object {
        const val JS_OBJECT_NAME = "__cloudsshAndroidPort"
        private const val TAG = "CloudSSHBridge"
    }
}
