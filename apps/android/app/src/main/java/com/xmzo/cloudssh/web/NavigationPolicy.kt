package com.xmzo.cloudssh.web

import android.net.Uri
import com.xmzo.cloudssh.config.InstanceRules

/**
 * 主 WebView 的导航规则：
 * - 实例 origin：留在应用内
 * - GitHub 登录/授权相关页面：留在应用内（OAuth 回调写入的 session Cookie 必须落在同一个 WebView Cookie 罐）
 * - 其他 http(s)：交给系统浏览器，避免离开网页版导致 SSH 会话被销毁
 */
object NavigationPolicy {
    enum class Decision { IN_APP, EXTERNAL_BROWSER, OTHER_APP }

    private val GITHUB_AUTH_PATHS = listOf("/login", "/session", "/sessions")

    fun decide(url: Uri, baseUrl: String): Decision {
        val scheme = url.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return Decision.OTHER_APP
        if (InstanceRules.isSameOrigin(url.toString(), baseUrl)) return Decision.IN_APP
        if (scheme == "https" && isGitHubAuth(url)) return Decision.IN_APP
        return Decision.EXTERNAL_BROWSER
    }

    private fun isGitHubAuth(url: Uri): Boolean {
        val host = url.host?.lowercase() ?: return false
        if (host != "github.com") return false
        val path = url.path ?: "/"
        return GITHUB_AUTH_PATHS.any { path == it || path.startsWith("$it/") }
    }
}
