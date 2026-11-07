# ترخيص خلفيات المكتبة

كل ملف في هذا المجلد مرخّص للاستخدام التجاري والتعديل، ومعه اسم المؤلف ورابط الترخيص ورابط الصفحة الأصلية. الجدول أدناه يُولَّد تلقائياً من `scripts/fetch-backgrounds.js`، فلا تعدّله يدوياً.

## الشروط

- مقبول فقط: **CC0** (المجال العام)، و**المجال العام** (Public domain)، و**CC BY** بأي إصدار (مع ذكر المؤلف).
- مرفوض: CC BY-SA، وCC BY-NC، وCC BY-ND، وأي ترخيص آخر (مثل GFDL).
- تُفحص الشروط تلقائياً من بيانات الملف في ويكيميديا كومنز، والملف الذي فيه قيود (علامة تجارية أو خصوصية) يُستبعد.
- ملفات الفيديو مقتطعة إلى 8 ثوانٍ بدقة 720 بكسل بلا صوت، والصور بعرض 1920 بكسل تقريباً.

## الفئات

الفئات هي المفاتيح في `CATEGORIES` داخل `js/library.js`. أي فئة غير معروفة تستبعد العنصر.

## إعادة الجلب

1. من GitHub: تبويب Actions، ثم «Android build»، ثم «Run workflow» على الفرع، مع تفعيل `fetch_backgrounds`.
2. محلياً (يحتاج Node 18 و ffmpeg): `node scripts/fetch-backgrounds.js`.

يستبدل التشغيل الملفات القديمة للفئات المذكورة في السكربت، ثم يعيد كتابة `manifest.json` والجدول أدناه.

<!-- AUTO:BEGIN -->
| الملف | الفئة | النوع | المؤلف | الترخيص | المصدر |
|---|---|---|---|---|---|
| 08020047 | غابات | صورة | Catalina Holguin | Public domain — https://creativecommons.org/publicdomain/mark/1.0/ | https://commons.wikimedia.org/wiki/File:08020047.JPG |
| 2011-07-29-deep-sky-7 | سماء ليلية | صورة | Thomas Bresson | CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/ | https://commons.wikimedia.org/wiki/File:2011-07-29-deep-sky-7.jpg |
| 500px photo (134652121) | جبال | صورة | Binaryboy | CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/ | https://commons.wikimedia.org/wiki/File:500px_photo_(134652121).jpeg |
| A scenic view of lands on the desert | صحاري | صورة | Gentry George, U.S. Fish and Wildlife Service | Public domain — https://creativecommons.org/publicdomain/mark/1.0/ | https://commons.wikimedia.org/wiki/File:A_scenic_view_of_lands_on_the_desert.jpg |
| Adriel Kloppenburg 2015-04-15 (Unsplash TyWBZWsZSSg) | غروب | صورة | Adriel Kloppenburg adriel | CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ | https://commons.wikimedia.org/wiki/File:Adriel_Kloppenburg_2015-04-15_(Unsplash_TyWBZWsZSSg).jpg |
| Around the Großglockner (3,798 m) | جبال | فيديو | Upabjojr | CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/ | https://commons.wikimedia.org/wiki/File:Around_the_Gro%C3%9Fglockner_(3,798_m).webm |
| AS09-20-3175 (21317153313) | شروق | صورة | Project Apollo Archive | Public domain — https://creativecommons.org/publicdomain/mark/1.0/ | https://commons.wikimedia.org/wiki/File:AS09-20-3175_(21317153313).jpg |
| Hands (4650623766) | طبيعة | صورة | David DeHetre from Lawrence, KS, USA, United States | CC BY 2.0 — https://creativecommons.org/licenses/by/2.0/ | https://commons.wikimedia.org/wiki/File:Hands_(4650623766).jpg |
| မိုးတိမ်တိုက် | غيوم | فيديو | စာကလေး | CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ | https://commons.wikimedia.org/wiki/File:%E1%80%99%E1%80%AD%E1%80%AF%E1%80%B8%E1%80%90%E1%80%AD%E1%80%99%E1%80%BA%E1%80%90%E1%80%AD%E1%80%AF%E1%80%80%E1%80%BA.webm |
| NEVER QUITE THE SAME | محيطات وبحار | صورة | Raymondsroad | CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ | https://commons.wikimedia.org/wiki/File:NEVER_QUITE_THE_SAME.png |
| - panoramio - Caihm (1) | شلالات | صورة | Caihm | CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/ | https://commons.wikimedia.org/wiki/File:-_panoramio_-_Caihm_(1).jpg |
| Two slender stems with leaf clusters against a cloudy sky, Lan Su Chinese Garden | غيوم | صورة | Z3lvs | CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ | https://commons.wikimedia.org/wiki/File:Two_slender_stems_with_leaf_clusters_against_a_cloudy_sky,_Lan_Su_Chinese_Garden.jpg |
<!-- AUTO:END -->
