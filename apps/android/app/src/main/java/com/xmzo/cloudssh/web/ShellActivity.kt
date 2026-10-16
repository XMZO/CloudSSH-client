package com.xmzo.cloudssh.web

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.ViewGroup
import android.window.OnBackInvokedDispatcher
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.xmzo.cloudssh.BuildConfig
import com.xmzo.cloudssh.R
import com.xmzo.cloudssh.config.Instance
import com.xmzo.cloudssh.config.InstanceRules
import com.xmzo.cloudssh.config.InstanceStore
import com.xmzo.cloudssh.manager.InstanceManagerActivity
import java.lang.ref.WeakReference

/**
 * 平台适配层：承载网页版 UI 的主界面。
 *
 * - UI 直接来自 Worker（页面位于 Worker origin），相对 /api、同源 WebSocket、HttpOnly Cookie 全部原生可用
 * - 每个实例一个 WebView Profile（系统 WebView 支持时），Cookie 与本地存储互相隔离
 * - bridge.js 只注入实例 origin：blob 下载、剪贴板、实例信息
 * - 横竖屏/键盘/深色模式变化不重建 Activity（见 Manifest configChanges），避免重载页面断开 SSH
 * - 只用框架 Activity API（不依赖 androidx.activity），release 包更小
 */
class ShellActivity : Activity() {

    private lateinit var store: InstanceStore
    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private var bridge: WebBridge? = null
    private var current: Instance? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val bridgeScript by lazy { assets.open("bridge.js").bufferedReader().use { it.readText() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        StorageTrimmer.trimOnStartup(this)
        store = InstanceStore(this)

        container = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.background)) }
        setContentView(container)
        SystemBars.install(this, container)

        // Android 13+ 走 OnBackInvokedCallback（Manifest 已启用），更早的版本走 onBackPressed
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }

        if (!handleIntent(intent)) {
            val snapshot = store.load()
            openInstance(snapshot.lastId ?: snapshot.defaultId)
        }
    }

    @Deprecated("Android 12 及以下的返回键入口")
    @Suppress("DEPRECATION")
    override fun onBackPressed() = handleBack()

    /** 先让页面关闭最上层浮层（抽屉/弹窗/编辑器），没有再走 WebView 历史，最后弹出原生菜单 */
    private fun handleBack() {
        val view = webView ?: return showMainMenu()
        view.evaluateJavascript(HANDLE_BACK_JS) { handled ->
            if (handled == "true") return@evaluateJavascript
            if (view.canGoBack()) view.goBack() else showMainMenu()
        }
    }

    @Deprecated("框架 Activity 的结果回调")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FILE) return
        val clip = data?.clipData
        val uris = when {
            resultCode != RESULT_OK || data == null -> null
            clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 处理“打开某实例 / 打开实例管理”请求；返回是否已处理 */
    private fun handleIntent(intent: Intent?): Boolean {
        if (intent?.action == ACTION_OPEN_MANAGER) {
            if (current == null) openInstance(store.load().let { it.lastId ?: it.defaultId })
            openManager()
            return true
        }
        val id = intent?.getStringExtra(EXTRA_INSTANCE_ID) ?: return false
        intent.removeExtra(EXTRA_INSTANCE_ID)
        if (current == null) openInstance(id) else confirmSwitch(id)
        return true
    }

    override fun onResume() {
        super.onResume()
        // 从实例管理返回：当前实例被删除/改地址/清除数据时重新加载
        val active = current ?: return
        val latest = store.get(active.id)
        when {
            latest == null -> store.load().let { openInstance(it.defaultId, force = true) }
            latest.baseUrl != active.baseUrl -> openInstance(latest.id, force = true)
            InstanceManagerActivity.consumeClearedFlag(active.id) -> webView?.loadUrl("${latest.baseUrl}/")
            else -> current = latest
        }
    }

    override fun onPause() {
        super.onPause()
        cookieManager()?.flush()
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }

    // ---------- 实例与 WebView ----------

    private fun profileName(instance: Instance) = "instance-${instance.id}"

    private fun usesProfiles() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    private fun cookieManager(): CookieManager? {
        val instance = current ?: return null
        return if (usesProfiles()) {
            ProfileStore.getInstance().getOrCreateProfile(profileName(instance)).cookieManager
        } else {
            CookieManager.getInstance()
        }
    }

    private fun openInstance(id: String, force: Boolean = false) {
        val instance = store.get(id) ?: store.load().let { snapshot -> snapshot.instances.first { it.id == snapshot.defaultId } }
        if (!force && current?.id == instance.id && webView != null) return
        destroyWebView()
        current = instance
        store.setLast(instance.id)
        val view = createWebView(instance)
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
        view.loadUrl("${instance.baseUrl}/")
    }

    private fun confirmSwitch(id: String) {
        val target = store.get(id) ?: return
        if (target.id == current?.id) return
        AlertDialog.Builder(this)
            .setTitle(R.string.switch_title)
            .setMessage(getString(R.string.switch_message, target.name))
            .setPositiveButton(R.string.switch_confirm) { _, _ -> openInstance(target.id) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(instance: Instance): WebView {
        val view = WebView(this)
        StorageTrimmer.markWebViewCreated()
        activeWebView = WeakReference(view)
        if (usesProfiles()) {
            // 必须在 WebView 的其他任何调用之前设置
            ProfileStore.getInstance().getOrCreateProfile(profileName(instance))
            WebViewCompat.setProfile(view, profileName(instance))
        }
        view.setBackgroundColor(getColor(R.color.background))
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            textZoom = 100
            builtInZoomControls = false
            displayZoomControls = false
            userAgentString = "$userAgentString CloudSSHAndroid/${BuildConfig.VERSION_NAME}"
        }
        val cookies = if (usesProfiles()) {
            ProfileStore.getInstance().getOrCreateProfile(profileName(instance)).cookieManager
        } else {
            CookieManager.getInstance()
        }
        cookies.setAcceptCookie(true)

        val origins = setOf(instance.baseUrl)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            val listener = WebBridge(this, instance) { runOnUiThread { openManager() } }
            WebViewCompat.addWebMessageListener(view, WebBridge.JS_OBJECT_NAME, origins, listener)
            bridge = listener
        }
        val documentStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (documentStart) WebViewCompat.addDocumentStartJavaScript(view, bridgeScript, origins)

        view.webViewClient = ShellClient(instance, injectOnPageStart = !documentStart)
        view.webChromeClient = ShellChromeClient()
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            handleDownload(instance, url, userAgent, contentDisposition, mimeType)
        }
        return view
    }

    private fun destroyWebView() {
        bridge?.dispose()
        bridge = null
        webView?.let { view ->
            container.removeView(view)
            view.stopLoading()
            view.destroy()
        }
        webView = null
    }

    // ---------- 菜单 ----------

    private fun showMainMenu() {
        val items = arrayOf(
            getString(R.string.menu_switch),
            getString(R.string.menu_manager),
            getString(R.string.menu_reload),
            getString(R.string.menu_background),
            getString(R.string.menu_exit),
        )
        AlertDialog.Builder(this)
            .setTitle(current?.let { "${it.name}（${Uri.parse(it.baseUrl).host}）" } ?: getString(R.string.app_name))
            .setItems(items) { _, which ->
                when (which) {
                    0 -> showSwitchDialog()
                    1 -> openManager()
                    2 -> webView?.reload()
                    3 -> moveTaskToBack(true)
                    4 -> finishAndRemoveTask()
                }
            }
            .show()
    }

    private fun showSwitchDialog() {
        val snapshot = store.load()
        val names = snapshot.instances.map { "${it.name}  (${Uri.parse(it.baseUrl).host})" }.toTypedArray()
        val checked = snapshot.instances.indexOfFirst { it.id == current?.id }
        AlertDialog.Builder(this)
            .setTitle(R.string.menu_switch)
            .setSingleChoiceItems(names, checked) { dialog, which ->
                dialog.dismiss()
                confirmSwitch(snapshot.instances[which].id)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openManager() {
        startActivity(Intent(this, InstanceManagerActivity::class.java))
    }

    // ---------- 下载 / 外部链接 ----------

    private fun handleDownload(instance: Instance, url: String, userAgent: String, disposition: String?, mime: String?) {
        val uri = Uri.parse(url)
        when (uri.scheme) {
            "blob", "data" -> Unit // 由 bridge.js 接管
            "http", "https" -> {
                if (NavigationPolicy.decide(uri, instance.baseUrl) != NavigationPolicy.Decision.IN_APP) {
                    openExternal(uri)
                    return
                }
                val name = URLUtil.guessFileName(url, disposition, mime)
                val request = DownloadManager.Request(uri)
                    .addRequestHeader("User-Agent", userAgent)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                cookieManager()?.getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
                getSystemService(DownloadManager::class.java).enqueue(request)
                Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            val intent = if (uri.scheme == "intent") {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } else {
                Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
            }
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.w(TAG, "open external failed: $uri", e)
        }
    }

    // ---------- WebView 回调 ----------

    private inner class ShellClient(
        private val instance: Instance,
        private val injectOnPageStart: Boolean,
    ) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return when (NavigationPolicy.decide(request.url, instance.baseUrl)) {
                NavigationPolicy.Decision.IN_APP -> false
                else -> {
                    openExternal(request.url)
                    true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // 旧版系统 WebView 不支持 document-start 注入时的退路（时机稍晚，但功能一致）
            if (injectOnPageStart && InstanceRules.isSameOrigin(url, instance.baseUrl)) {
                view.evaluateJavascript(bridgeScript, null)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            Log.w(TAG, "main frame error ${error.errorCode} ${error.description} ${request.url}")
            AlertDialog.Builder(this@ShellActivity)
                .setTitle(R.string.load_failed_title)
                .setMessage(getString(R.string.load_failed_message, instance.name, error.description))
                .setPositiveButton(R.string.retry) { _, _ -> view.loadUrl("${instance.baseUrl}/") }
                .setNeutralButton(R.string.menu_manager) { _, _ -> openManager() }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "renderer gone, crashed=${detail.didCrash()}")
            if (view == webView) {
                webView = null
                container.removeView(view)
                view.destroy()
                openInstance(instance.id, force = true)
            }
            return true
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val intent = params.createIntent().apply {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            }
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(intent, REQUEST_FILE)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // 网页版不需要摄像头/麦克风等权限
            request.deny()
        }
    }

    companion object {
        const val EXTRA_INSTANCE_ID = "com.xmzo.cloudssh.extra.INSTANCE_ID"
        const val ACTION_OPEN_MANAGER = "com.xmzo.cloudssh.action.OPEN_MANAGER"
        private const val HANDLE_BACK_JS =
            "(function(){try{return !!(window.cloudsshAndroid&&window.cloudsshAndroid.handleBack());}catch(e){return false;}})()"
        private const val TAG = "CloudSSH"
        private const val REQUEST_FILE = 1001

        private var activeWebView: WeakReference<WebView>? = null

        /** 实例管理“清除缓存”：有活动 WebView 时用官方 API 清 HTTP 缓存，再清空 cacheDir 其余内容 */
        fun clearWebCache(context: android.content.Context) {
            activeWebView?.get()?.clearCache(true)
            StorageTrimmer.clearCacheDir(context)
        }
    }
}
