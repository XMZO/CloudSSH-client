package com.xmzo.cloudssh.manager

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.Executors

/**
 * “测试连接”：读取 /api/config，并探测 /api/auth/github 的 302 里服务端实际使用的 OAuth 回调地址
 * （与桌面端实例管理一致，帮助发现“用 workers.dev 访问导致 redirect_uri 不匹配”这类问题）。
 */
object InstanceProbe {
    data class Result(
        val ok: Boolean,
        val latencyMs: Long,
        val authMode: String? = null,
        val loginRequired: Boolean = false,
        val sharingEnabled: Boolean = false,
        val oauthRedirectUri: String? = null,
        val error: String? = null,
    )

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    fun run(baseUrl: String, callback: (Result) -> Unit) {
        executor.execute {
            val started = System.currentTimeMillis()
            val result = try {
                val config = JSONObject(get("$baseUrl/api/config"))
                val latency = System.currentTimeMillis() - started
                val redirect = if (config.optBoolean("githubAuthEnabled")) probeRedirect(baseUrl) else null
                Result(
                    ok = true,
                    latencyMs = latency,
                    authMode = config.optString("authMode"),
                    loginRequired = config.optBoolean("githubAuthRequired"),
                    sharingEnabled = config.optBoolean("sshSharingEnabled"),
                    oauthRedirectUri = redirect,
                )
            } catch (e: Exception) {
                Result(ok = false, latencyMs = System.currentTimeMillis() - started, error = e.message ?: e.javaClass.simpleName)
            }
            main.post { callback(result) }
        }
    }

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
        }

    private fun get(url: String): String {
        val connection = open(url)
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun probeRedirect(baseUrl: String): String? {
        val connection = open("$baseUrl/api/auth/github")
        return try {
            if (connection.responseCode !in 300..399) return null
            val location = connection.getHeaderField("Location") ?: return null
            URI(location).rawQuery?.split('&')
                ?.firstOrNull { it.startsWith("redirect_uri=") }
                ?.substringAfter('=')
                ?.let { java.net.URLDecoder.decode(it, "UTF-8") }
        } catch (e: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }
}
