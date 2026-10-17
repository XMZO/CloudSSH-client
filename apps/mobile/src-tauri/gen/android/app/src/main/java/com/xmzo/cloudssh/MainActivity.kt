package com.xmzo.cloudssh

import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RemoteViews
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.content.res.AppCompatResources
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/** 应用自身页面的主机名（打包的界面；tauri dev 时是本机 Vite） */
private val APP_HOSTS = setOf("tauri.localhost", "localhost", "127.0.0.1")

private const val TAG = "CloudSSH"

/** 这段时间内渲染进程连续退出达到上限就不再自动重建，改为显示“重新加载”页，避免无限循环 */
private const val CRASH_LOOP_WINDOW_MS = 60_000L
private const val CRASH_LOOP_LIMIT = 3

/** 用浏览器登录时，Custom Tab 底部“完成登录”发回本 Activity 的动作（浏览器会把当前页面地址放进 intent data） */
private const val ACTION_AUTH_TAB_DONE = "com.xmzo.cloudssh.AUTH_TAB_DONE"

/** Custom Tab 的工具栏、动作按钮、菜单项都支持完整的浏览器，按优先级 */
private val AUTH_TAB_BROWSERS = listOf(
  "com.android.chrome",
  "com.chrome.beta",
  "com.chrome.dev",
  "com.chrome.canary",
  "com.microsoft.emmx",
  "com.sec.android.app.sbrowser",
  "com.brave.browser",
  "com.vivaldi.browser",
)

/** 剪贴板文字里的回调地址 */
private val CALLBACK_IN_TEXT = Regex("""https?://[^\s"'<>]+/api/auth/callback\?[^\s"'<>]+""")

class MainActivity : TauriActivity() {
  private val defaultBackground = Color.parseColor("#131313")
  private val mainHandler = Handler(Looper.getMainLooper())

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
    // 从登录标签页回来却没点“完成登录”（返回键、关闭按钮、多任务切换）：等拿到窗口焦点后看看剪贴板里
    // 有没有复制的回调地址（浏览器不显示“完成登录”时的兜底），没有就当作取消。
    // 点了“完成登录”时 onNewIntent 先于 onResume，已经交出结果
    if (authTabLeft) {
      authTabReturned = true
      // 焦点迟迟不来（例如上面还盖着系统弹窗）也要结束等待
      mainHandler.postDelayed({ if (authTabReturned) finishAuthTab(null) }, 2_000)
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Android 10 起要有窗口焦点才能读剪贴板
    if (hasFocus && authTabReturned) finishAuthTab(callbackFromClipboard())
  }

  override fun onPause() {
    super.onPause()
    if (authTabResult != null) authTabLeft = true
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == ACTION_AUTH_TAB_DONE) finishAuthTab(intent.dataString)
  }

  // ---------- 用浏览器登录（Custom Tab） ----------

  /** 等待浏览器登录结果的回调：点“完成登录”时的页面地址，关掉标签页时为 null */
  private var authTabResult: ((String?) -> Unit)? = null
  /** 标签页已经盖住本页面（之后回到本页面就说明标签页关了） */
  private var authTabLeft = false
  /** 已经回到本页面，等窗口焦点去读剪贴板 */
  private var authTabReturned = false

  /**
   * 选浏览器。不少厂商浏览器打开 Custom Tab 时不显示自定义的工具栏和菜单项，用户会卡在授权后的页面上找不到
   * “完成登录”。所以默认浏览器在支持完整的名单里才用它（它里面最可能已经登录了 GitHub）；否则用名单里已安装的
   * 第一个；都没有再退回默认的 Custom Tab 浏览器，靠“复制链接后切回应用”兜底。
   */
  private fun authTabBrowser(): String? {
    val default = CustomTabsClient.getPackageName(this, null)
    if (default != null && default in AUTH_TAB_BROWSERS) return default
    return CustomTabsClient.getPackageName(this, AUTH_TAB_BROWSERS, true) ?: default
  }

  /** 右上角的 ✓（工具栏动作按钮）：和底部工具栏、菜单项是同一个“完成登录”，哪个浏览器支持哪个都能用 */
  private fun authDoneIcon(): Bitmap {
    val size = (24 * resources.displayMetrics.density).toInt()
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    AppCompatResources.getDrawable(this, R.drawable.ic_auth_done)?.apply {
      setBounds(0, 0, size, size)
      draw(Canvas(bitmap))
    }
    return bitmap
  }

  /**
   * 在系统浏览器的 Custom Tab 里打开登录页（passkey、密码管理器都能用），“完成登录”同时放在底部工具栏、
   * 右上角按钮和菜单里。浏览器点击它们时会把当前页面地址作为 intent data 发回来（singleTask：本 Activity
   * 回到前台并关掉标签页）。没有支持 Custom Tab 的浏览器时返回 false。
   */
  fun openAuthTab(url: String, onResult: (String?) -> Unit): Boolean {
    val browser = authTabBrowser() ?: return false
    finishAuthTab(null)
    // Android 14 起，从后台拉起 Activity 的 PendingIntent 要声明允许：这里声明本应用这一方允许
    // （浏览器作为发送方也会声明），否则部分系统上点了“完成登录”没有反应
    val options = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      @Suppress("DEPRECATION")
      ActivityOptions.makeBasic()
        .setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
        .toBundle()
    } else {
      null
    }
    val done = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).setAction(ACTION_AUTH_TAB_DONE),
      // 浏览器要把当前地址写进 intent data，必须可变；目标是显式的本 Activity
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      options,
    )
    val colors = CustomTabColorSchemeParams.Builder()
      .setToolbarColor(defaultBackground)
      .setSecondaryToolbarColor(defaultBackground)
      .setNavigationBarColor(defaultBackground)
      .build()
    val tab = CustomTabsIntent.Builder()
      .setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
      .setDefaultColorSchemeParams(colors)
      .setShowTitle(true)
      .setActionButton(authDoneIcon(), getString(R.string.auth_tab_done), done, true)
      .setSecondaryToolbarViews(RemoteViews(packageName, R.layout.auth_tab_toolbar), intArrayOf(R.id.auth_tab_done), done)
      .addMenuItem(getString(R.string.auth_tab_done), done)
      .build()
    tab.intent.setPackage(browser)
    authTabResult = onResult
    authTabLeft = false
    authTabReturned = false
    return try {
      tab.launchUrl(this, Uri.parse(url))
      true
    } catch (error: Exception) {
      Log.w(TAG, "custom tab failed: $error")
      authTabResult = null
      false
    }
  }

  /**
   * 浏览器里没有“完成登录”时的兜底：用户复制了地址栏里的回调地址再切回来。只取形如
   * …/api/auth/callback?…code=…&state=… 的地址；是不是本实例、这次登录的回调由 Rust 再核对。
   */
  private fun callbackFromClipboard(): String? {
    val clipboard = getSystemService(CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    val description = clipboard.primaryClipDescription ?: return null
    if (!description.hasMimeType("text/*") && !description.hasMimeType(ClipDescription.MIMETYPE_TEXT_URILIST)) return null
    val text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: return null
    return CALLBACK_IN_TEXT.find(text)?.value?.takeIf { "code=" in it && "state=" in it }
  }

  private fun finishAuthTab(url: String?) {
    val result = authTabResult ?: return
    authTabResult = null
    authTabLeft = false
    authTabReturned = false
    result(url)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.post { raiseBackCallback() }
    webView.setBackgroundColor(defaultBackground)
    // 切到后台时 WebView 渲染进程仍保持“重要”优先级，配合前台服务让会话心跳不中断
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }
    // wry 先调用 setWebView（走到这里）再设置 RustWebViewClient，两者在同一次主线程任务里：
    // 排到下一轮再套保护层，拿到的才是 wry 的客户端
    mainHandler.post { guardRenderProcess(webView) }
  }

  private fun guardRenderProcess(view: WebView) {
    val current = view.webViewClient
    if (current is RenderProcessGuardClient) return
    view.webViewClient = RenderProcessGuardClient(current, ::onRenderProcessGone)
    Log.i(TAG, "render process guard installed on ${current.javaClass.simpleName}")
  }

  /**
   * WebView 渲染进程退出了（被系统回收，或者崩溃）。不处理的话 WebView 会让整个应用跟着崩溃。
   *
   * 处理后这个 WebView 实例不能再用：摘下来销毁，再在当前 Activity 里重新创建一个（见 rebuildWebView），
   * 新页面从应用首页开始，Rust 侧状态（实例、登录、设置）不受影响。
   * 网页里的会话随渲染进程一起没了：保活服务立即停掉（新页面加载后会按实际会话数重新同步），
   * 旧页面留在 Rust 侧的 WebSocket 在新页面开始加载时统一关闭（lib.rs 的 on_page_load）。
   */
  private fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail) {
    Log.w(TAG, "WebView render process gone: crashed=${detail.didCrash()}, priority=${detail.rendererPriorityAtExit()}")
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
    if (webView === view) webView = null
    KeepAliveService.stop(this)
    if (isFinishing || isDestroyed) return

    val now = SystemClock.elapsedRealtime()
    recoveries.removeAll { now - it > CRASH_LOOP_WINDOW_MS }
    if (recoveries.size >= CRASH_LOOP_LIMIT) {
      Log.w(TAG, "render process keeps dying, waiting for the user to reload")
      showReloadPage()
      return
    }
    recoveries.addLast(now)
    // 不在 WebView 的回调里直接重建
    mainHandler.post { rebuildWebView() }
  }

  /**
   * 再走一遍 tao/wry 的 Activity 创建绑定：wry 按 Activity id 保留着原来的 WebView 参数（页面地址、
   * 注入脚本、IPC、自定义协议），发现已有参数就据此重新创建 WebView 并 setContentView 换上去。
   * 这和配置变更后重建 Activity 走的是同一段代码，只是不销毁 Activity：tauri 插件挂在这个 Activity 上的
   * 返回键回调、权限请求等都继续有效（重建 Activity 会丢掉它们，之后按返回键会直接退出应用）。
   */
  private fun rebuildWebView() {
    if (isFinishing || isDestroyed) return
    Rust.onCreate(this)
  }

  /** 渲染进程短时间内反复退出：停在一个原生页面上，由用户决定何时再试 */
  private fun showReloadPage() {
    val gap = (24 * resources.displayMetrics.density).toInt()
    val message = TextView(this).apply {
      setText(R.string.renderer_gone)
      setTextColor(Color.parseColor("#E5E2E1"))
      textSize = 16f
      gravity = Gravity.CENTER
    }
    val reload = Button(this).apply {
      setText(R.string.renderer_reload)
      isAllCaps = false
      setTextColor(Color.parseColor("#E5E2E1"))
      backgroundTintList = ColorStateList.valueOf(Color.parseColor("#2C2F36"))
      // 只响应一次：连点会创建两个 WebView
      setOnClickListener {
        isEnabled = false
        rebuildWebView()
      }
    }
    val page = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(gap, gap, gap, gap)
      setBackgroundColor(defaultBackground)
      addView(message)
      addView(reload, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = gap })
    }
    setContentView(page)
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

  private companion object {
    /** 最近几次自动恢复的时间 */
    val recoveries = ArrayDeque<Long>()
  }
}
