#!/usr/bin/env node
/*
 * يجلب خلفيات طبيعة (صور وفيديوهات قصيرة) من ويكيميديا كومنز، ويقبل فقط الملفات التي
 * ترخيصها يسمح بالاستخدام التجاري والتعديل مع ذكر المؤلف:
 *   CC0، والمجال العام (Public domain)، وCC BY بأي إصدار.
 * يرفض CC BY-SA و CC BY-NC و CC BY-ND وأي ترخيص آخر.
 *
 * يفضّل الملفات المختارة بجودة في كومنز (Featured / Quality / Valued)، ويستبعد الملفات
 * التي تصنيفها يدل على أشخاص أو شعارات أو إعلانات أو نصوص.
 *
 * يكتب الملفات في app/src/main/assets/www/backgrounds/<الفئة>/، ثم يعيد كتابة
 * manifest.json وجدول التراخيص داخل LICENSES.md (بين علامتي AUTO).
 *
 * يحتاج Node 18+ و ffmpeg. شغّله محلياً، أو من GitHub Actions بتفعيل fetch_backgrounds في workflow «Android build»
 * لأن بيئة التطوير قد تكون محجوبة عن ويكيميديا:
 *   node scripts/fetch-backgrounds.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BG_DIR = path.join(ROOT, "app", "src", "main", "assets", "www", "backgrounds");
const MANIFEST_FILE = path.join(BG_DIR, "manifest.json");
const LICENSES_FILE = path.join(BG_DIR, "LICENSES.md");
const LIBRARY = require(path.join(ROOT, "app", "src", "main", "assets", "www", "js", "library.js"));

const API = "https://commons.wikimedia.org/w/api.php";
// اسم عام للعميل، بدون بيانات شخصية. ويكيميديا تطلب اسماً واضحاً للعميل.
const USER_AGENT = "inaba-quran-clips-background-fetch/1.0 (https://github.com/AlGrands0n/inaba-quran-clips)";

// فئات التطبيق -> تصنيفات كومنز. نقرأ من كل تصنيف حتى حد الصفحات، ثم نختار حسب الجودة.
const SOURCES = {
  mountains: ["Mountains", "Mountain landscapes"],
  oceans: ["Oceans", "Seascapes", "Sea"],
  forests: ["Forests", "Forest landscapes"],
  waterfalls: ["Waterfalls"],
  deserts: ["Deserts", "Desert landscapes"],
  rain: ["Rain", "Rainy weather"],
  clouds: ["Clouds", "Cloudscapes", "Cumulus clouds"],
  sunrise: ["Sunrises", "Sunrise landscapes"],
  sunset: ["Sunsets", "Sunset landscapes"],
  nightsky: ["Night sky", "Milky Way", "Starry night"],
  stars: ["Starry sky", "Stars"],
  nature: ["Landscapes", "Nature"],
};
// بحث في كومنز عن فيديوهات بكل فئة. التصنيفات أغلبها CC BY-SA، فنبحث عن الفيديو مباشرة.
const VIDEO_QUERY = {
  mountains: "mountains landscape",
  oceans: "ocean waves",
  forests: "forest nature",
  waterfalls: "waterfall",
  deserts: "desert landscape",
  rain: "rain nature",
  clouds: "clouds sky",
  sunrise: "sunrise landscape",
  sunset: "sunset landscape",
  nightsky: "night sky stars",
  stars: "starry sky",
  nature: "nature landscape",
};
const MAX_SEARCH_PAGES = 3;
const PHOTOS_PER_CATEGORY = 3;
const VIDEOS_PER_CATEGORY = 1;
const MAX_PAGES_PER_SOURCE = 10; // كل صفحة 100 ملف، فالحد 1000 ملف لكل تصنيف
const MIN_PHOTO_WIDTH = 1600;
const MIN_VIDEO_WIDTH = 1280;
const MIN_VIDEO_SECONDS = 4;
const VIDEO_SECONDS = 6; // المقطع يتكرر في التطبيق، فنكتفي بجزء قصير
const MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;

// مراجعة يدوية بعد التشغيل: ملفات قبلها الفلتر الآلي لكن محتواها لا يناسب الخلفيات.
// المفتاح هو معرّف العنصر في المانيفست، والقيمة سبب الاستبعاد. أي ملف جديد يُراجَع بنفس الطريقة.
const REVIEW_EXCLUDED = new Map([
  ["commons-tripoloskifotografiallc-1", "علامة نصية (حقوق) في الزاوية"],
  ["commons-tripoloskifotografiallc-3", "علامة نصية (حقوق) في الزاوية"],
  ["commons-two-slender-stems-with-leaf-clusters-against-a-cloudy-sky-la", "ليس سحاباً، نبتة أمام السماء"],
  ["commons-hands-4650623766", "طريق ليلاً وليس طبيعة"],
  ["commons-2011-07-29-deep-sky-7", "وهج مدينة وليس سماء ليلية"],
  ["commons-2011-07-29-deep-sky-8", "غروب وأشجار وليس سماء ليلية"],
  ["commons-2011-07-29-deep-sky-8-2", "غروب وأشجار وليس سماء ليلية"],
  ["commons-starless-core-l1014", "رسم معلوماتي فيه نصوص"],
  ["commons-never-quite-the-same", "شعار وعبارة نصية على الصورة"],
  ["commons-balance-and-strength-3853768707", "شخص يركب الأمواج في المقدمة"],
  ["commons-around-the-gro-glockner-3-798-m", "رسوم متراكبة فوق الفيديو"],
  ["commons-nascer-do-sol-em-piracicaba-24-06-2023", "نصوص متراكبة فوق الفيديو"],
  ["commons-88-constellations-piece-13h25m0-1693-cc", "رسم خريطة نجوم وليس صورة سماء"],
]);

// تصنيفات كومنز التي تدل على جودة مختارة من المجتمع
const QUALITY_CATEGORY_RE = /^Category:(Featured pictures|Quality images|Valued images)/i;
// تصنيفات تدل على أشخاص أو شعارات أو إعلانات أو نصوص: نستبعد الملف
const EXCLUDE_CATEGORY_RE = /\b(advertis\w*|logos?|brands?|posters?|signs?|portraits?|people|persons?|humans?|men|women|children|faces?|selfies?|text)\b/i;

// ---------- الترخيص ----------

/*
 * يرجّع اسم الترخيص ورابطه إذا كان مقبولاً، وإلا null.
 * المقبول: CC0، المجال العام، CC BY بأي إصدار. مرفوض: أي ترخيص فيه NC أو ND أو SA.
 */
function classifyLicense(shortName) {
  const s = String(shortName || "").replace(/\s+/g, " ").trim();
  if (!s || /\b(NC|ND|SA)\b|NonCommercial|NoDerivs|ShareAlike|GFDL|GPL/i.test(s)) return null;
  if (/^CC0\b/i.test(s)) {
    return { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: false };
  }
  if (/^(Public domain|PD)\b/i.test(s)) {
    return { name: "Public domain", url: "https://creativecommons.org/publicdomain/mark/1.0/", attribution: false };
  }
  const m = s.match(/^CC BY (\d(?:\.\d)?)$/i);
  if (m) return { name: `CC BY ${m[1]}`, url: `https://creativecommons.org/licenses/by/${m[1]}/`, attribution: true };
  return null;
}

// ---------- نصوص ----------

// يحوّل HTML من ويكيميديا (مثل اسم المؤلف) إلى نص عادي
function plainText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// اسم ملف آمن للنظام (ASCII)، ويُرجع "item" إذا ما بقي شيء
function slugify(text) {
  const s = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "item";
}

// ---------- تحويل نتيجة كومنز إلى عنصر في المانيفست ----------

/*
 * يرجّع {skip} مع السبب، أو {item, kind, url, size, quality} إذا كان الملف مقبولاً.
 * page: عنصر من query.pages مع prop=imageinfo|categories (formatversion=2).
 */
function buildCandidate(page, category) {
  const info = page && Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  if (!info) return { skip: "لا توجد بيانات ملف" };

  const categories = (page.categories || []).map((c) => c.title || "");
  if (categories.some((t) => EXCLUDE_CATEGORY_RE.test(t))) {
    return { skip: "تصنيف يدل على أشخاص أو شعارات أو إعلانات" };
  }

  const meta = info.extmetadata || {};
  const value = (key) => plainText(meta[key] && meta[key].value);

  const licenseName = value("LicenseShortName");
  const license = classifyLicense(licenseName);
  if (!license) return { skip: `ترخيص غير مقبول: ${licenseName || "غير معروف"}` };
  if (value("Restrictions")) return { skip: "عليه قيود (علامة تجارية أو خصوصية)" };

  const author = value("Artist").slice(0, 120);
  if (license.attribution && !author) return { skip: "CC BY بدون اسم مؤلف" };

  let kind;
  let ext;
  if (info.mediatype === "BITMAP" && /^image\/(jpeg|png)$/.test(info.mime || "")) {
    kind = "image";
    ext = "jpg";
    if (!(info.width >= MIN_PHOTO_WIDTH)) return { skip: "صورة صغيرة" };
  } else if (info.mediatype === "VIDEO" && /^video\//.test(info.mime || "")) {
    kind = "video";
    ext = "mp4";
    if (!(info.width >= MIN_VIDEO_WIDTH)) return { skip: "فيديو بدقة صغيرة" };
    if (!(info.duration >= MIN_VIDEO_SECONDS)) return { skip: "فيديو قصير جداً" };
    if (!(info.size <= MAX_ORIGINAL_BYTES)) return { skip: "ملف الفيديو كبير جداً" };
  } else {
    return { skip: `نوع غير مدعوم: ${info.mime || info.mediatype || "?"}` };
  }

  const title = String(page.title || "")
    .replace(/^File:/i, "")
    .replace(/\.[^.]+$/, "")
    .replace(/_/g, " ")
    .trim();
  const slug = slugify(title);
  const item = {
    id: `commons-${slug}`,
    title,
    category,
    type: kind,
    file: `${category}/${slug}.${ext}`,
    license: `${license.name} — ${license.url}`,
    source: info.descriptionurl || page.title,
    author: author || "غير مذكور في الملف",
  };
  if (REVIEW_EXCLUDED.has(item.id)) return { skip: `مستبعد بعد المراجعة: ${REVIEW_EXCLUDED.get(item.id)}` };
  const url = kind === "video" ? info.url : info.thumburl || info.url;
  const quality = categories.some((t) => QUALITY_CATEGORY_RE.test(t));
  return { item, kind, url, size: info.size, quality };
}

// ---------- الشبكة والتحويل ----------

async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getJson(url) {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

async function download(url, dest, maxBytes) {
  await withRetry(async () => {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("الملف كبير جداً");
    fs.writeFileSync(dest, buf);
  });
}

// يقرأ ملفات من تصنيف كومنز أو من بحث كومنز، صفحة بصفحة (مع توكن المتابعة) حتى الحد
async function* filePages(spec, maxPages) {
  const base = spec.search
    ? { generator: "search", gsrsearch: spec.search, gsrnamespace: "6", gsrlimit: "100" }
    : { generator: "categorymembers", gcmtitle: `Category:${spec.category}`, gcmtype: "file", gcmlimit: "100" };
  let cont = {};
  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      ...base,
      prop: "imageinfo|categories",
      iiprop: "url|size|mime|mediatype|extmetadata|duration",
      iiurlwidth: "1920",
      iiextmetadatafilter: "LicenseShortName|Artist|Restrictions",
      cllimit: "max",
      ...cont,
    });
    const data = await getJson(`${API}?${params}`);
    for (const page of (data.query && data.query.pages) || []) yield page;
    if (!data.continue) return;
    cont = data.continue;
  }
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

// يحمّل الأصل ويحوّله إلى الملف النهائي. يرجّع حجم الناتج.
async function produce(candidate, tmpDir, outFile) {
  const src = path.join(tmpDir, `src-${Math.random().toString(36).slice(2)}`);
  await download(candidate.url, src, MAX_ORIGINAL_BYTES);
  try {
    if (candidate.kind === "image") {
      ffmpeg(["-i", src, "-frames:v", "1", "-q:v", "4", outFile]);
    } else {
      ffmpeg([
        "-i", src, "-t", String(VIDEO_SECONDS), "-an",
        "-vf", "scale=-2:720,fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "30", "-movflags", "+faststart",
        outFile,
      ]);
    }
  } finally {
    fs.rmSync(src, { force: true });
  }
  const size = fs.statSync(outFile).size;
  if (size > MAX_OUTPUT_BYTES) {
    fs.rmSync(outFile, { force: true });
    throw new Error(`الناتج كبير جداً (${Math.round(size / 1024)} ك.ب)`);
  }
  return size;
}

// ---------- كتابة المانيفست وجدول التراخيص ----------

const TABLE_BEGIN = "<!-- AUTO:BEGIN -->";
const TABLE_END = "<!-- AUTO:END -->";

function renderLicenseTable(items) {
  const cell = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const rows = items.map((i) => [
    cell(i.title),
    cell(LIBRARY.CATEGORIES[i.category] || i.category),
    i.type === "video" ? "فيديو" : "صورة",
    cell(i.author),
    cell(i.license),
    cell(i.source),
  ].join(" | ")).map((r) => `| ${r} |`);
  return [
    "| الملف | الفئة | النوع | المؤلف | الترخيص | المصدر |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function writeLicenses(items) {
  const table = items.length ? renderLicenseTable(items) : "لا توجد ملفات بعد.";
  const block = `${TABLE_BEGIN}\n${table}\n${TABLE_END}`;
  const current = fs.existsSync(LICENSES_FILE) ? fs.readFileSync(LICENSES_FILE, "utf8") : "";
  const re = new RegExp(`${TABLE_BEGIN}[\\s\\S]*?${TABLE_END}`);
  const next = re.test(current) ? current.replace(re, () => block) : `${current.trimEnd()}\n\n## الملفات\n\n${block}\n`;
  fs.writeFileSync(LICENSES_FILE, next);
}

// ---------- التشغيل ----------

async function main() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch (_) {
    throw new Error("ffmpeg غير مثبت. ثبّته أولاً (مثلاً: sudo apt-get install ffmpeg).");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bg-fetch-"));
  // نبدأ من فئات نظيفة، فالتشغيل الجديد يستبدل القديم
  for (const category of Object.keys(SOURCES)) {
    fs.rmSync(path.join(BG_DIR, category), { recursive: true, force: true });
  }

  const items = [];
  const usedTitles = new Set(); // كل ملف يظهر في فئة واحدة فقط
  for (const [category, sources] of Object.entries(SOURCES)) {
    // 1) نجمع المرشحين من التصنيفات وبحث الفيديو (بدون تكرار)
    const seen = new Set();
    const pages = [];
    const specs = [
      ...sources.map((name) => ({ category: name, max: MAX_PAGES_PER_SOURCE })),
      { search: `filetype:video ${VIDEO_QUERY[category]}`, max: MAX_SEARCH_PAGES },
    ];
    for (const spec of specs) {
      try {
        for await (const page of filePages(spec, spec.max)) {
          if (seen.has(page.title)) continue;
          seen.add(page.title);
          pages.push(page);
        }
      } catch (err) {
        console.log(`[${category}] تعذر قراءة "${spec.category || spec.search}": ${err.message}`);
      }
    }

    // 2) نفلتر حسب الترخيص والنوع والجودة، ونسجّل أسباب الاستبعاد للتشخيص
    const reasons = new Map();
    const candidates = [];
    for (const page of pages) {
      const cand = buildCandidate(page, category);
      if (cand.skip) {
        reasons.set(cand.skip, (reasons.get(cand.skip) || 0) + 1);
        continue;
      }
      candidates.push(cand);
    }
    // الملفات المختارة بالجودة أولاً (الترتيب الأصلي محفوظ داخل كل مجموعة)
    candidates.sort((a, b) => Number(b.quality) - Number(a.quality));
    const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([r, n]) => `${r} (${n})`).join("، ");
    console.log(`[${category}] ${pages.length} ملف، مرشّح ${candidates.length}${topReasons ? ` — أكثر أسباب الاستبعاد: ${topReasons}` : ""}`);

    // 3) نحمّل ونحوّل حتى تكتمل الحصة
    let photos = 0;
    let videos = 0;
    for (const cand of candidates) {
      if (photos >= PHOTOS_PER_CATEGORY && videos >= VIDEOS_PER_CATEGORY) break;
      if (cand.kind === "image" && photos >= PHOTOS_PER_CATEGORY) continue;
      if (cand.kind === "video" && videos >= VIDEOS_PER_CATEGORY) continue;
      if (usedTitles.has(cand.item.title)) continue;
      const outFile = path.join(BG_DIR, category, path.basename(cand.item.file));
      try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const size = await produce(cand, tmp, outFile);
        items.push(cand.item);
        usedTitles.add(cand.item.title);
        if (cand.kind === "image") photos++;
        else videos++;
        console.log(`  + ${cand.item.file} (${Math.round(size / 1024)} ك.ب) — ${cand.item.license}${cand.quality ? " [مختار]" : ""}`);
      } catch (err) {
        console.log(`  - تجاوز ${cand.item.title}: ${err.message}`);
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!items.length) throw new Error("لم يُجلب أي ملف. تحقق من التصنيفات أو من اتصال الشبكة.");

  items.sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    version: 1,
    note: "كل عنصر لازم يكون له: id, title, category, type (image أو video), file, license, source, author. التفاصيل في LICENSES.md. هذا الملف يُولَّد بـ scripts/fetch-backgrounds.js.",
    items,
  };
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  writeLicenses(items);
  console.log(`تم: ${items.length} ملف (${items.filter((i) => i.type === "video").length} فيديو).`);
}

module.exports = {
  classifyLicense,
  plainText,
  slugify,
  buildCandidate,
  renderLicenseTable,
  SOURCES,
  TABLE_BEGIN,
  TABLE_END,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
