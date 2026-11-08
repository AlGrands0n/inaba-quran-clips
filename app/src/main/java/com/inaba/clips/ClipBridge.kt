package com.inaba.clips

import android.content.ContentValues
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * جسر بين صفحة الويب والتطبيق (window.InabaBridge).
 *
 * الملف المُصدَّر يوصل من الصفحة على شكل أجزاء base64، نكتبه بملف مؤقت في الكاش،
 * وبعدين ننقله لمجلد داخل التنزيلات باسم التطبيق (Download/إنابة) عبر MediaStore،
 * بنفس الاسم العربي. MediaStore ينشئ المجلد تلقائياً، ولا يحتاج صلاحية تخزين على أندرويد 10 فما فوق.
 *
 * ملاحظة: كل الدوال هنا ترجّع قيم ولا ترمي استثناءات، لأن الاستثناء داخل JavascriptInterface
 * ممكن يوقّف التطبيق.
 */
class ClipBridge(private val host: MainActivity) {

    private var tempFile: File? = null
    private var tempStream: OutputStream? = null
    private var pendingName: String = ""
    private var pendingMime: String = ""

    @JavascriptInterface
    fun beginSave(fileName: String, mimeType: String): Boolean {
        cancelSave()
        return try {
            val name = safeFileName(fileName)
            val file = File(host.cacheDir, "export-${System.currentTimeMillis()}.part")
            tempStream = FileOutputStream(file)
            tempFile = file
            pendingName = name
            // نوع الملف لازم يطابق الامتداد، وإلا المعرض يعرض الفيديو مضروباً أو ما يفتحه
            pendingMime = mimeFor(name) ?: mimeType.substringBefore(';').trim()
            true
        } catch (e: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun appendChunk(base64: String): Boolean {
        val stream = tempStream ?: return false
        return try {
            stream.write(Base64.decode(base64, Base64.DEFAULT))
            true
        } catch (e: Exception) {
            cancelSave()
            false
        }
    }

    /** يرجّع مسار الملف المحفوظ (مثل Download/الفاتحة 1-7.mp4)، أو نص يبدأ بـ ERROR إذا فشل. */
    @JavascriptInterface
    fun endSave(): String {
        val stream = tempStream ?: return "ERROR: لم يبدأ الحفظ"
        val file = tempFile ?: return "ERROR: لا يوجد ملف مؤقت"
        return try {
            stream.close()
            tempStream = null
            publishToDownloads(file, pendingName, pendingMime)
        } catch (e: Exception) {
            "ERROR: ${e.message ?: "خطأ غير معروف"}"
        } finally {
            file.delete()
            tempFile = null
        }
    }

    @JavascriptInterface
    fun cancelSave() {
        try {
            tempStream?.close()
        } catch (_: Exception) {
        }
        tempStream = null
        tempFile?.delete()
        tempFile = null
    }

    /** يبقي الشاشة مفتوحة أثناء التصدير حتى ما تطفي وتوقف الرسم. */
    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
        host.runOnUiThread {
            if (on) {
                host.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                host.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    /** يشغّل خدمة التصدير (إشعار بالتقدّم، ويمنع إيقاف التطبيق). */
    @JavascriptInterface
    fun startExportService(text: String): Boolean {
        return try {
            val intent = Intent(host, ExportService::class.java).putExtra(ExportService.EXTRA_TEXT, text)
            ContextCompat.startForegroundService(host, intent)
            true
        } catch (e: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun updateExportService(percent: Int, text: String) {
        if (!ExportService.running) return
        try {
            val intent = Intent(host, ExportService::class.java)
                .setAction(ExportService.ACTION_UPDATE)
                .putExtra(ExportService.EXTRA_PERCENT, percent)
                .putExtra(ExportService.EXTRA_TEXT, text)
            host.startService(intent)
        } catch (_: Exception) {
        }
    }

    @JavascriptInterface
    fun stopExportService() {
        if (!ExportService.running) return
        try {
            val intent = Intent(host, ExportService::class.java).setAction(ExportService.ACTION_STOP)
            host.startService(intent)
        } catch (_: Exception) {
        }
    }

    /** يحذف الأحرف اللي ما تنفع في أسماء الملفات، ويبقي العربي والمسافات والأرقام. */
    private fun safeFileName(raw: String): String {
        val cleaned = raw
            .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (cleaned.isEmpty()) return "مقطع قرآني"
        val dot = cleaned.lastIndexOf('.')
        val ext = if (dot > 0 && cleaned.length - dot <= 5) cleaned.substring(dot) else ""
        val base = cleaned.substring(0, cleaned.length - ext.length)
        return base.take(MAX_BASE_LENGTH).trimEnd() + ext
    }

    private fun mimeFor(name: String): String? = when {
        name.endsWith(".mp4", ignoreCase = true) -> "video/mp4"
        name.endsWith(".webm", ignoreCase = true) -> "video/webm"
        else -> null
    }

    /** اسم المجلد داخل التنزيلات = اسم التطبيق من strings.xml، بدون أحرف ممنوعة في أسماء المجلدات. */
    private fun appFolder(): String =
        host.getString(R.string.app_name)
            .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .ifEmpty { "مقاطع قرآنية" }

    /** يرجّع مسار الملف النهائي داخل التنزيلات (النظام قد يضيف رقماً إذا كان الاسم مستخدماً). */
    private fun publishToDownloads(file: File, name: String, mime: String): String {
        val resolver = host.contentResolver
        val folder = "${Environment.DIRECTORY_DOWNLOADS}/${appFolder()}"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "$folder/")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return "ERROR: تعذر إنشاء الملف في التنزيلات"

        return try {
            val out = resolver.openOutputStream(uri)
                ?: throw IllegalStateException("تعذر فتح الملف للكتابة")
            out.use { output -> file.inputStream().use { input -> input.copyTo(output) } }

            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)

            val finalName = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
                ?: name
            "$folder/$finalName"
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            "ERROR: ${e.message ?: "تعذر الكتابة"}"
        }
    }

    private companion object {
        const val MAX_BASE_LENGTH = 120
    }
}
