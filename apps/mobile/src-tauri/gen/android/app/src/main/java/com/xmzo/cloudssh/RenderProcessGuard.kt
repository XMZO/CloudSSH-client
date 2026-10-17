package com.xmzo.cloudssh

import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Message
import android.view.KeyEvent
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * 给 wry 的 RustWebViewClient 套一层：其余回调原样转发，只接管“渲染进程退出”。
 *
 * RustWebViewClient 没有实现 onRenderProcessGone，默认返回 false：渲染进程被系统回收或崩溃时，
 * WebView 会让整个应用跟着崩溃退出。它是 tauri 每次构建都会重新生成的文件，不能直接改，
 * 所以由 MainActivity 在 wry 设置好它之后包上这一层（见 MainActivity.guardRenderProcess）。
 * 转发了 WebViewClient 的全部公开回调：被包装的客户端没有覆盖的方法，走它自己的默认实现，行为不变。
 */
class RenderProcessGuardClient(
    val inner: WebViewClient,
    private val onGone: (WebView, RenderProcessGoneDetail) -> Unit,
) : WebViewClient() {

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        // 以后的 wry 若自己处理了，就交给它
        if (inner.onRenderProcessGone(view, detail)) return true
        onGone(view, detail)
        return true
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        inner.shouldOverrideUrlLoading(view, url)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        inner.shouldOverrideUrlLoading(view, request)

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
        inner.onPageStarted(view, url, favicon)

    override fun onPageFinished(view: WebView, url: String) = inner.onPageFinished(view, url)

    override fun onLoadResource(view: WebView, url: String) = inner.onLoadResource(view, url)

    override fun onPageCommitVisible(view: WebView, url: String) = inner.onPageCommitVisible(view, url)

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
        inner.shouldInterceptRequest(view, url)

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        inner.shouldInterceptRequest(view, request)

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onTooManyRedirects(view: WebView, cancelMsg: Message, continueMsg: Message) =
        inner.onTooManyRedirects(view, cancelMsg, continueMsg)

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) =
        inner.onReceivedError(view, errorCode, description, failingUrl)

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
        inner.onReceivedError(view, request, error)

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) =
        inner.onReceivedHttpError(view, request, errorResponse)

    override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
        inner.onFormResubmission(view, dontResend, resend)

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
        inner.doUpdateVisitedHistory(view, url, isReload)

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
        inner.onReceivedSslError(view, handler, error)

    override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
        inner.onReceivedClientCertRequest(view, request)

    override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) =
        inner.onReceivedHttpAuthRequest(view, handler, host, realm)

    override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean =
        inner.shouldOverrideKeyEvent(view, event)

    override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = inner.onUnhandledKeyEvent(view, event)

    override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) =
        inner.onScaleChanged(view, oldScale, newScale)

    override fun onReceivedLoginRequest(view: WebView, realm: String, account: String?, args: String) =
        inner.onReceivedLoginRequest(view, realm, account, args)

    override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, callback: SafeBrowsingResponse) =
        inner.onSafeBrowsingHit(view, request, threatType, callback)
}
