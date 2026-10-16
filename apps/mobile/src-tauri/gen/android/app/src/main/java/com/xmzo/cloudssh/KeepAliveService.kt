package com.xmzo.cloudssh

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * 有 SSH 会话时运行的前台服务：让进程保持前台优先级、CPU 与 Wi-Fi 不休眠，
 * 切到后台或锁屏后 Rust 侧的 WebSocket 与网页的心跳/输出确认仍能继续，会话不掉线。
 * 会话数变化时只更新通知；全部关闭后停止服务并释放锁。
 */
class KeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification(this, intent?.getIntExtra(EXTRA_SESSIONS, 1) ?: 1, intent?.getStringExtra(EXTRA_TITLE), intent?.getStringExtra(EXTRA_TEXT))
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        acquireLocks()
        // 进程被系统回收后不自动重启：会话本身已经不在了，空跑服务没有意义
        return START_NOT_STICKY
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CloudSSH:sessions").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifiLock == null) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = runCatching {
                wifi.createWifiLock(mode, "CloudSSH:sessions").apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }.getOrNull()
        }
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        wifiLock = null
        if (running === this) running = null
        super.onDestroy()
    }

    /** 用户从最近任务里划掉应用：会话随 WebView 一起结束，服务也跟着停 */
    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        private const val CHANNEL_ID = "sessions"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_SESSIONS = "sessions"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"

        @Volatile
        private var running: KeepAliveService? = null

        fun update(context: Context, sessions: Int, title: String, text: String) {
            val service = running
            if (service != null) {
                // 已在前台运行：直接刷新通知，避免后台再次 startForegroundService 被系统拒绝
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                manager.notify(NOTIFICATION_ID, buildNotification(context, sessions, title, text))
                return
            }
            val intent = Intent(context, KeepAliveService::class.java)
                .putExtra(EXTRA_SESSIONS, sessions)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text)
            runCatching { ContextCompat.startForegroundService(context, intent) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, KeepAliveService::class.java))
        }

        private fun buildNotification(context: Context, sessions: Int, title: String?, text: String?): Notification {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.keepalive_channel), NotificationManager.IMPORTANCE_LOW).apply {
                    description = context.getString(R.string.keepalive_channel_description)
                    setShowBadge(false)
                }
                manager.createNotificationChannel(channel)
            }
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_terminal)
                .setContentTitle(title?.ifBlank { null } ?: "CloudSSH")
                .setContentText(text?.ifBlank { null } ?: context.getString(R.string.keepalive_text, sessions))
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build()
        }
    }
}
