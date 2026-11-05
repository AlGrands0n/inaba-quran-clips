package com.inaba.clips

import android.content.ContentValues
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * جسر بين صفحة الويب والتطبيق (window.InabaBridge).
 *
 * الفيديو المُصدَّر بيوصل من الصفحة على شكل أجزاء base64 (حتى ما نحمّل ملف كبير كنص واحد)،
 * وبنكتبه بملف مؤقت، وبعدين بننقله لمجلد Download/Inaba عبر MediaStore.
 *
 * ملاحظة: كل الدوال هنا بترجّع قيم ولا بترمي استثناءات، لأن الاستثناء داخل JavascriptInterface
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
            val safeName = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val file = File(host.cacheDir, "export-${System.currentTimeMillis()}.part")
            tempStream = FileOutputStream(file)
            tempFile = file
            pendingName = safeName
            pendingMime = mimeType
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

    /** يرجّع مسار الملف المحفوظ، أو نص يبدأ بـ ERROR إذا فشل. */
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

    /** يبقي الشاشة مفتوحة أثناء التسجيل حتى ما تطفي وتوقف الرسم. */
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

    private fun publishToDownloads(file: File, name: String, mime: String): String {
        val resolver = host.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, RELATIVE_FOLDER)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return "ERROR: تعذر إنشاء الملف في التنزيلات"

        try {
            val out = resolver.openOutputStream(uri)
                ?: throw IllegalStateException("تعذر فتح الملف للكتابة")
            out.use { output -> file.inputStream().use { input -> input.copyTo(output) } }

            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            return "ERROR: ${e.message ?: "تعذر الكتابة"}"
        }
        return "$RELATIVE_FOLDER$name"
    }

    private companion object {
        const val RELATIVE_FOLDER = "Download/Inaba/"
    }
}
