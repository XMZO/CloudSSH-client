package com.xmzo.cloudssh.config

import java.net.URI
import java.text.Normalizer

/**
 * 实例 = 一个已部署的 CloudSSH Worker 地址。
 * 规则与 packages/core/src/instance.ts 保持一致（normalizeWorkerUrl / isValidInstanceId / createInstanceId），
 * 改动其中一边时请同步另一边。
 */
data class Instance(
    /** 稳定 ID：决定 WebView Profile 名（Cookie/本地存储隔离），创建后不变 */
    val id: String,
    val name: String,
    /** 规范化后的 Worker 根地址（只含 origin） */
    val baseUrl: String,
)

class InstanceConfigException(message: String) : IllegalArgumentException(message)

object InstanceRules {
    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "[::1]", "::1", "10.0.2.2")
    private val ID_PATTERN = Regex("^[a-z0-9][a-z0-9-]{0,63}$")

    /**
     * 规范化 Worker 地址：只保留 origin；仅允许 https，本地开发地址允许 http
     * （额外放行 10.0.2.2：Android 模拟器访问宿主机 wrangler dev 的地址）。
     */
    fun normalizeWorkerUrl(input: String): String {
        val raw = input.trim()
        if (raw.isEmpty()) throw InstanceConfigException("Worker 地址不能为空")
        val withScheme = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(raw)) raw else "https://$raw"
        val uri = try {
            URI(withScheme)
        } catch (e: Exception) {
            throw InstanceConfigException("无法解析 Worker 地址：$raw")
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase() ?: throw InstanceConfigException("无法解析 Worker 地址：$raw")
        if (uri.rawUserInfo != null) throw InstanceConfigException("Worker 地址不能包含用户名或密码")
        when (scheme) {
            "https" -> Unit
            "http" -> if (host !in LOOPBACK_HOSTS) {
                throw InstanceConfigException("仅本地开发地址允许使用 http，其余必须使用 https")
            }
            else -> throw InstanceConfigException("不支持的协议：$scheme")
        }
        val path = uri.rawPath ?: ""
        if (path.isNotEmpty() && path != "/") throw InstanceConfigException("Worker 地址只能是根地址，不能带路径")
        if (uri.rawQuery != null || uri.rawFragment != null) {
            throw InstanceConfigException("Worker 地址只能是根地址，不能带参数")
        }
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    fun isValidId(id: String): Boolean = ID_PATTERN.matches(id)

    fun createId(name: String, existing: Collection<String>): String {
        val base = Normalizer.normalize(name.lowercase(), Normalizer.Form.NFKD)
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .take(40)
            .ifEmpty { "instance" }
        if (base !in existing) return base
        for (i in 2 until 10_000) {
            val candidate = "$base-$i"
            if (candidate !in existing) return candidate
        }
        return "$base-${System.currentTimeMillis().toString(36)}"
    }

    /** 判断 URL 是否属于该实例 origin（http/https、ws/wss 视为同源，与网页版口径一致） */
    fun isSameOrigin(url: String, baseUrl: String): Boolean {
        return try {
            val target = URI(url)
            val scheme = when (target.scheme?.lowercase()) {
                "wss" -> "https"
                "ws" -> "http"
                else -> target.scheme?.lowercase()
            }
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (target.port == -1 || target.port == defaultPort) "" else ":${target.port}"
            "$scheme://${target.host?.lowercase()}$port" == baseUrl
        } catch (e: Exception) {
            false
        }
    }
}
