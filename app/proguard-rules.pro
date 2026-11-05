# قواعد ProGuard/R8 للتطبيق

# الجسر بين الصفحة والتطبيق: لازم تضل أسماء الدوال كما هي، لأن الصفحة بتناديها بالاسم
-keepclassmembers class com.inaba.clips.ClipBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.inaba.clips.ClipBridge { *; }

# WebViewAssetLoader يستخدم الأسماء بالانعكاس في بعض الإصدارات
-keep class androidx.webkit.** { *; }
