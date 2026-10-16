package com.xmzo.cloudssh

import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/** 应用自身页面的主机名（打包的界面；tauri dev 时是本机 Vite） */
private val APP_HOSTS = setOf("tauri.localhost", "localhost", "127.0.0.1")

class MainActivity : TauriActivity() {
  private val defaultBackground = Color.parseColor("#131313")

  override fun onCreate(savedInstanceState: Bundle?) {
    Storage.trimOnStartup(this)
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(defaultBackground)

    // 全面屏：内容画在系统栏下面，用 padding 让出状态栏、导航栏、刘海与键盘。
    // 键盘弹出时底部 padding 变大，WebView 随之变矮，网页版的终端据此重新计算行数。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  var webView: WebView? = null
    private set

  /**
   * 外部页面（GitHub 登录等）上的返回键：网页版注册的返回监听留在应用页面里，跳走时来不及注销，
   * 返回事件会发给已经不存在的页面而没有反应。这里直接让 WebView 回退，退不了就回应用首页；
   * 在应用自己的页面上则交还给网页处理（关浮层 → 回节点页 → 退到后台）。
   */
  private val externalPageBack = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      val view = webView
      val host = view?.url?.let { Uri.parse(it).host }
      if (view != null && host != null && host !in APP_HOSTS) {
        if (view.canGoBack()) view.goBack() else view.loadUrl("https://tauri.localhost/")
        return
      }
      isEnabled = false
      onBackPressedDispatcher.onBackPressed()
      isEnabled = true
    }
  }

  /** 保持在返回回调链最上层（AppPlugin 的回调注册得更早） */
  private fun raiseBackCallback() {
    externalPageBack.remove()
    onBackPressedDispatcher.addCallback(this, externalPageBack)
  }

  override fun onResume() {
    super.onResume()
    raiseBackCallback()
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.post { raiseBackCallback() }
    webView.setBackgroundColor(defaultBackground)
    // 切到后台时 WebView 渲染进程仍保持“重要”优先级，配合前台服务让会话心跳不中断
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }
  }

  /** 由 NativePlugin.systemBars 调用：系统栏区域与网页背景同色，图标深浅随亮度切换 */
  fun applySystemBarColor(value: String) {
    val color = runCatching { Color.parseColor(value) }.getOrNull() ?: return
    window.decorView.setBackgroundColor(color)
    val luminance = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = luminance > 0.6
    controller.isAppearanceLightNavigationBars = luminance > 0.6
  }
}
