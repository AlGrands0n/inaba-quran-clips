#!/usr/bin/env node
/*
 * يجلب خلفيات طبيعة (صور وفيديوهات قصيرة) من ويكيميديا كومنز، من قائمة معتمدة بعناوين الملفات.
 * كل ملف في القائمة راجعناه يدوياً (الفئة والمحتوى والشعارات)، والسكربت لا يبحث عن ملفات جديدة،
 * فكل تشغيل يعطي المكتبة نفسها. أي ملف جديد يُضاف إلى APPROVED بعد مراجعته.
 *
 * يقبل الملف فقط إذا كان ترخيصه CC0 أو المجال العام أو CC BY بأي إصدار، ويرفض CC BY-SA و CC BY-NC و CC BY-ND.
 * إذا تعذّر أي ملف من القائمة يفشل التشغيل كله ولا تتغير المكتبة، حتى لا تنقص بصمت.
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
const TITLES_PER_REQUEST = 20;

const MIN_PHOTO_WIDTH = 1600;
const MIN_VIDEO_WIDTH = 1280;
const MIN_VIDEO_SECONDS = 4;
const VIDEO_SECONDS = 6; // المقطع يتكرر في التطبيق، فنكتفي بجزء قصير
const MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;

// القائمة المعتمدة: عنوان الملف في كومنز + فئته في التطبيق.
// راجعنا كل ملف بصرياً (إطارات من الفيديو) وتأكدنا من الترخيص وغياب الشعارات والنصوص.
const APPROVED = [
  { category: "clouds", title: "File:မိုးတိမ်တိုက်.webm" },

  { category: "deserts", title: "File:A scenic view of lands on the desert.jpg" },
  { category: "deserts", title: "File:A scenic view of the desert with mountains in the background on the desert.jpg" },
  { category: "deserts", title: "File:A view of the desert with sand dunes in the foreground and mountains in the background.jpg" },
  { category: "deserts", title: "File:Hungate Canyon in Washington.webm" },

  { category: "forests", title: "File:- panoramio (2538).jpg" },
  { category: "forests", title: "File:- panoramio (4047).jpg" },
  { category: "forests", title: "File:08020047.JPG" },
  { category: "forests", title: "File:Desolation Creek in Oregon, USA.webm" },

  { category: "mountains", title: "File:20160919164811 - Black Mountain south of Cooktown (29264110154).jpg" },
  { category: "mountains", title: "File:20161022143430 - Hills beyond Childers (29890269773).jpg" },
  { category: "mountains", title: "File:500px photo (134652121).jpeg" },

  { category: "nature", title: "File:151473 dry leaves PikiWiki Israel.jpg" },
  { category: "nature", title: "File:Goats in Sunnyvale.webm" },
  { category: "nature", title: "File:Graceful Birds in the Sky-Amazing Bird Sound-User FREE Videos.webm" },
  { category: "nature", title: "File:JNUDR024 (47930111511).jpg" },
  { category: "nature", title: "File:La Vigolana vista dalla strada vecchia per Vigolo Vattaro.jpg" },

  { category: "nightsky", title: "File:2011-08-27 22-23-58-nightscape-under-clouds.jpg" },
  { category: "nightsky", title: "File:2011-08-27 22-34-12-iridium-flare.jpg" },
  { category: "nightsky", title: "File:ESOcast 63.webm" },

  { category: "oceans", title: "File:08040 Baunei, Province of Ogliastra, Italy - panoramio (2).jpg" },
  { category: "oceans", title: "File:2016 366 76 West (25849338025).jpg" },
  { category: "oceans", title: "File:500px photo (32815753).jpeg" },

  { category: "rain", title: "File:Grand Canyon National Park Bright and Colorful - After a Gentle Rain (13115283315).webm" },

  { category: "stars", title: "File:-i---i- (24196687643).jpg" },
  { category: "stars", title: "File:30010035352 Jpg (195626321).jpeg" },
  { category: "stars", title: "File:88 Constellations Piece (17h21m-30-1706-CC).jpg" },

  { category: "sunrise", title: "File:500px photo (44617892).jpeg" },
  { category: "sunrise", title: "File:AS09-20-3175 (21317153313).jpg" },
  { category: "sunrise", title: "File:Adriel Kloppenburg 2015-04-15 (Unsplash UYtyy-K1nS8).jpg" },

  { category: "sunset", title: "File:Abends Am See (222401769).jpeg" },
  { category: "sunset", title: "File:Adriel Kloppenburg 2015-04-15 (Unsplash TyWBZWsZSSg).jpg" },
  { category: "sunset", title: "File:Anthony DELANOIX 2015-04-14 (Unsplash).jpg" },
  { category: "sunset", title: "File:Clouds at sunset (time lapse).webm" },

  { category: "waterfalls", title: "File:- panoramio - Caihm (1).jpg" },
  { category: "waterfalls", title: "File:500px photo (240996567).jpeg" },
  { category: "waterfalls", title: "File:500px photo (61931629).jpeg" },
  { category: "waterfalls", title: "File:Krimmler Wasserfaelle Waterfall in Austria Biggest from Europe 380m at the top.webm" },
];

// مرفوضة بعد المراجعة ولا تُضاف (للمرجع):
//  - علامات نصية أو شعارات أو بطاقات عنوان على الفيديو: tripoloskifotografiallc-1 و-3، never-quite-the-same،
//    around-the-gro-glockner-3-798-m، nascer-do-sol-em-piracicaba، mount-bromo، a-zoom-to-the-star،
//    starry-sky-with-north-star-circled، gravity-waves-ripple-over-lake-superior (شعار في الزاوية)
//  - ليست طبيعة أو ليست صورة طبيعية: two-slender-stems (نبتة)، hands-4650623766 (طريق ليلاً)، deep-sky-7 و-8 (وهج مدينة أو غروب)،
//    balance-and-strength (شخص يركب الأمواج)، 160316-f-yg608 (آلية عسكرية)، 121004-m-aq224 (طائرة عسكرية)،
//    frozen-drop (تجربة مخبرية)، nasa-ocean-ecosystem (رسم يدوي)، starless-core-l1014 (رسم معلوماتي فيه نصوص)،
//    tess-completes-its-primary-mission (مركبة فضائية متحركة)، september-27-2015-total-lunar-eclipse (رسم فضائي)،
//    88-constellations-13h25m (خريطة نجوم على الأرجح)

// الفئات المستخدمة في القائمة (بدون تكرار)
const CATEGORY_KEYS = [...new Set(APPROVED.map((a) => a.category))];

// تصنيفات كومنز التي تدل على أشخاص أو شعارات أو إعلانات أو نصوص: نرفض الملف
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

function normalizeTitle(title) {
  return String(title || "").replace(/_/g, " ").trim();
}

// ---------- تحويل نتيجة كومنز إلى عنصر في المانيفست ----------

/*
 * يرجّع {skip} مع السبب، أو {item, kind, url, size} إذا كان الملف مقبولاً.
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
  const url = kind === "video" ? info.url : info.thumburl || info.url;
  return { item, kind, url, size: info.size };
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

// يجلب بيانات ملفات محددة بعناوينها (على دفعات)، بدون بحث
async function fetchPagesByTitle(titles) {
  const pages = [];
  for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      titles: titles.slice(i, i + TITLES_PER_REQUEST).join("|"),
      prop: "imageinfo|categories",
      iiprop: "url|size|mime|mediatype|extmetadata|duration",
      iiurlwidth: "1920",
      iiextmetadatafilter: "LicenseShortName|Artist|Restrictions",
      cllimit: "max",
    });
    const data = await getJson(`${API}?${params}`);
    pages.push(...((data.query && data.query.pages) || []));
  }
  return pages;
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
  const stage = path.join(tmp, "out");
  const items = [];
  const failures = [];
  const ids = new Set();
  try {
    // 1) نجلب بيانات كل الملفات المعتمدة بعناوينها
    const pages = await fetchPagesByTitle(APPROVED.map((a) => a.title));
    const byTitle = new Map(pages.map((p) => [normalizeTitle(p.title), p]));

    // 2) نتحقق من كل ملف ونحوّله إلى مجلد مؤقت (المكتبة لم تتغير بعد)
    for (const entry of APPROVED) {
      const page = byTitle.get(normalizeTitle(entry.title));
      if (!page || page.missing) {
        failures.push(`${entry.title}: غير موجود في كومنز`);
        continue;
      }
      const cand = buildCandidate(page, entry.category);
      if (cand.skip) {
        failures.push(`${entry.title}: ${cand.skip}`);
        continue;
      }
      if (ids.has(cand.item.id)) {
        failures.push(`${entry.title}: معرّف مكرر ${cand.item.id}`);
        continue;
      }
      const outFile = path.join(stage, entry.category, path.basename(cand.item.file));
      try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const size = await produce(cand, tmp, outFile);
        ids.add(cand.item.id);
        items.push(cand.item);
        console.log(`  + ${cand.item.file} (${Math.round(size / 1024)} ك.ب) — ${cand.item.license}`);
      } catch (err) {
        failures.push(`${entry.title}: ${err.message}`);
      }
    }
    if (failures.length) {
      throw new Error(`تعذّر ${failures.length} ملف من القائمة المعتمدة، ولم تتغير المكتبة:\n  - ${failures.join("\n  - ")}`);
    }
    if (!items.length) throw new Error("القائمة المعتمدة فارغة.");

    items.sort((a, b) => a.id.localeCompare(b.id));
    const check = LIBRARY.validateManifest({ items });
    if (check.errors.length) throw new Error(`المانيفست غير صالح: ${check.errors.join("، ")}`);

    // 3) كل الملفات جاهزة: نستبدل فئاتها في المكتبة دفعة واحدة
    for (const category of CATEGORY_KEYS) {
      fs.rmSync(path.join(BG_DIR, category), { recursive: true, force: true });
    }
    fs.cpSync(stage, BG_DIR, { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

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
  APPROVED,
  TABLE_BEGIN,
  TABLE_END,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
