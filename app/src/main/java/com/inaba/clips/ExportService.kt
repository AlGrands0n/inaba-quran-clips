package com.inaba.clips

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * خدمة أمامية (foreground) تُشغَّل أثناء التصدير. تمنع النظام من إيقاف التطبيق وهو يجهّز المقطع،
 * وتعرض التقدّم في شريط الإشعارات.
 *
 * ملاحظة: المتصفح يبطّئ الصفحة إذا كانت بالخلفية، لذلك التصدير يكمل لكن الأسرع يبقى التطبيق مفتوحاً.
 */
class ExportService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                running = false
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_UPDATE -> {
                if (running) {
                    val percent = intent.getIntExtra(EXTRA_PERCENT, 0)
                    val text = intent.getStringExtra(EXTRA_TEXT)
                    getSystemService(NotificationManager::class.java)
                        .notify(NOTIFICATION_ID, build(percent, text))
                }
            }
            else -> {
                running = true
                ensureChannel()
                val notification = build(0, intent?.getStringExtra(EXTRA_TEXT))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(CHANNEL_ID, "تقدّم التصدير", NotificationManager.IMPORTANCE_LOW)
            manager.createNotificationChannel(channel)
        }
    }

    private fun build(percent: Int, text: String?): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("صانع المقاطع القرآنية")
            .setContentText(text ?: "جاري تجهيز المقطع")
            .setProgress(100, percent.coerceIn(0, 100), false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent)
            .build()
    }

    companion object {
        /** يكون true من بدء الخدمة حتى إيقافها. النشاط يستخدمه ليبقي الصفحة فعّالة أثناء التصدير. */
        @Volatile
        var running: Boolean = false

        const val ACTION_UPDATE = "com.inaba.clips.export.UPDATE"
        const val ACTION_STOP = "com.inaba.clips.export.STOP"
        const val EXTRA_PERCENT = "percent"
        const val EXTRA_TEXT = "text"

        private const val CHANNEL_ID = "export"
        private const val NOTIFICATION_ID = 7001
    }
}
