package com.inaba.clips

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader

/**
 * الشاشة الوحيدة: تعرض صانع المقاطع (ملفات الويب المضمّنة في assets/www).
 *
 * - الملفات بتنحمّل من https://appassets.androidplatform.net عبر WebViewAssetLoader،
 *   فالصفحة بتشتغل بأصل (origin) حقيقي وتقدر تستخدم fetch وWebCodecs بشكل طبيعي.
 * - منتقي الملفات (صور، فيديو، صوت) عبر Storage Access Framework، بدون صلاحيات تخزين.
 * - الجسر InabaBridge يحفظ الفيديو في التنزيلات ويبقي الشاشة مفتوحة ويشغّل خدمة التصدير.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        filePathCallback?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        filePathCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                // المعاينة والتصدير يبدآن بدون ضغطة من المستخدم
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            webViewClient = AppWebViewClient()
            webChromeClient = AppChromeClient()
            addJavascriptInterface(ClipBridge(this@MainActivity), BRIDGE_NAME)
        }
        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        webView.loadUrl(START_URL)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        // أثناء التصدير ما نوقف الصفحة: خدمة التصدير الأمامية تمنع إيقاف العملية
        if (!ExportService.running) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private inner class AppWebViewClient : WebViewClient() {

        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
            request?.url?.let { assetLoader.shouldInterceptRequest(it) }

        // أي رابط خارجي (مثلاً من الشروط أو المصادر) يفتح في المتصفح، لا داخل التطبيق
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val uri = request?.url ?: return false
            if (uri.host == DOMAIN) return false
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            return true
        }
    }

    private inner class AppChromeClient : WebChromeClient() {

        override fun onShowFileChooser(
            webView: WebView?,
            callback: ValueCallback<Array<Uri>>?,
            params: WebChromeClient.FileChooserParams?,
        ): Boolean {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = callback

            // إذا الحقل يقبل نوع واحد (مثل audio/*) نستخدمه، وإلا نعرض كل الملفات
            val types = params?.acceptTypes?.filter { it.isNotBlank() }.orEmpty()
            val mime = if (types.size == 1 && !types[0].contains(",")) types[0] else "*/*"

            return try {
                pickFiles.launch(mime)
                true
            } catch (e: Exception) {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = null
                false
            }
        }
    }

    companion object {
        private const val DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "https://$DOMAIN/assets/www/index.html"
        private const val BRIDGE_NAME = "InabaBridge"
    }
}
