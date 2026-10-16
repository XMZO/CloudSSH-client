package com.xmzo.cloudssh.web

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.WindowInsets
import kotlin.math.max

/**
 * 全面屏适配（只用框架 API，不引入 androidx.core/activity，以压缩 APK）：
 * 内容画到系统栏下面，再用 padding 让出状态栏、导航栏、刘海与键盘的空间。
 * 键盘弹出时 root 的底部 padding 变大，WebView 随之变矮，网页版据此调整终端行数。
 */
object SystemBars {
    fun install(activity: Activity, root: View) {
        val window = activity.window
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            // Android 15+（targetSdk 35）系统强制全面屏，无需设置
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION")
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            root.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        root.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
                WindowInsets.CONSUMED
            } else {
                // Android 10：配合 adjustResize，systemWindowInsets 已包含键盘高度
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                @Suppress("DEPRECATION")
                insets.consumeSystemWindowInsets()
            }
        }
        root.requestApplyInsets()
    }
}
