package com.xmzo.cloudssh

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 后台提醒（长命令结束、终端响铃、会话断线与重连，判断在网页里做）：普通优先级的通知，
 * 每个会话标签一条（新的替换旧的）。点通知回到应用，MainActivity 再让页面切到对应标签；
 * 回到应用时收起已发的提醒。没有通知权限时什么也不做。
 */
object EventNotifications {
    const val ACTION_OPEN_TAB = "com.xmzo.cloudssh.OPEN_TAB"
    const val EXTRA_TAB = "tab"
    private const val CHANNEL_ID = "events"
    private val posted = mutableSetOf<Int>()

    fun show(context: Context, title: String, text: String, tab: String) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(context)
        // 保活通知用的是 1，这里从 1000 开始
        val id = 1000 + (tab.hashCode() and 0x7fff)
        val open = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_TAB)
            .putExtra(EXTRA_TAB, tab)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setContentTitle(title.ifBlank { "CloudSSH" })
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            manager.notify(id, notification)
            synchronized(posted) { posted.add(id) }
        } catch (_: SecurityException) {
            // Android 13+ 运行时被收回了通知权限
        }
    }

    fun clear(context: Context) {
        val manager = NotificationManagerCompat.from(context)
        synchronized(posted) {
            posted.forEach(manager::cancel)
            posted.clear()
        }
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.events_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = context.getString(R.string.events_channel_description)
        }
        manager.createNotificationChannel(channel)
    }
}
