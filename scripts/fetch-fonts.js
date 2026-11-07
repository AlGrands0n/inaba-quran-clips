#!/usr/bin/env node
/*
 * يُنزّل الخطوط العربية من حزم @fontsource على npm (رخصة SIL OFL 1.1)، ويكتب ملفات woff2
 * و fonts.css داخل app/src/main/assets/www/fonts/، حتى يعمل التطبيق بدون اتصال بخوادم الخطوط.
 *
 * يحتاج اتصالاً بـ registry.npmjs.org، لذلك يُشغَّل من GitHub Actions (workflow «Android build»
 * مع تفعيل fetch_fonts)، أو محلياً عند وجود اتصال:
 *   node scripts/fetch-fonts.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "app", "src", "main", "assets", "www", "fonts");
const REGISTRY = "https://registry.npmjs.org";
const USER_AGENT = "inaba-quran-clips-font-fetch/1.0 (https://github.com/AlGrands0n/inaba-quran-clips)";

const WEIGHTS = [400, 700];
const SUBSETS = ["arabic", "latin"];

// نطاقات الأحرف لكل مجموعة، حتى يختار المتصفح الملف الصحيح لكل حرف
const UNICODE_RANGE = {
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  arabic: "U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0898-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC",
};

// أسماء العائلات هنا لازم تطابق ما يستخدمه التطبيق في index.html وrenderer.js
const FAMILIES = [
  { family: "Noto Sans Arabic", pkg: "noto-sans-arabic" },
  { family: "Noto Naskh Arabic", pkg: "noto-naskh-arabic" },
  { family: "Amiri", pkg: "amiri" },
  { family: "Amiri Quran", pkg: "amiri-quran", optional: true },
  { family: "Scheherazade New", pkg: "scheherazade-new" },
];

/** يبني CSS لـ @font-face. المسارات نسبية لملف fonts.css نفسه. */
function buildFontFaceCss(entries) {
  const blocks = entries.map((e) => [
    "@font-face {",
    `  font-family: "${e.family}";`,
    "  font-style: normal;",
    `  font-weight: ${e.weight};`,
    "  font-display: swap;",
    `  src: url("${e.file}") format("woff2");`,
    `  unicode-range: ${UNICODE_RANGE[e.subset]};`,
    "}",
  ].join("\n"));
  return `${blocks.join("\n\n")}\n`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} من ${url}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} من ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** يحمّل حزمة @fontsource ويفكّها في مجلد مؤقت، ويرجّع مجلدها وإصدارها. */
async function fetchPackage(pkg, tmp) {
  const meta = await fetchJson(`${REGISTRY}/@fontsource/${pkg}`);
  const version = meta["dist-tags"] && meta["dist-tags"].latest;
  const tarball = version && meta.versions[version] && meta.versions[version].dist.tarball;
  if (!tarball) throw new Error(`لا توجد نسخة منشورة للحزمة ${pkg}`);
  const dir = fs.mkdtempSync(path.join(tmp, `${pkg}-`));
  const tgz = path.join(dir, "package.tgz");
  fs.writeFileSync(tgz, await fetchBuffer(tarball));
  execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  return { version, dir: path.join(dir, "package") };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "font-fetch-"));
  const entries = [];
  const credits = [];
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, "licenses"), { recursive: true });

    for (const f of FAMILIES) {
      let pkg;
      try {
        pkg = await fetchPackage(f.pkg, tmp);
      } catch (err) {
        if (f.optional) {
          console.log(`تخطّي ${f.family}: ${err.message}`);
          continue;
        }
        throw err;
      }

      // نجمع ملفات العائلة أولاً؛ إذا نقص شيء نتخطى العائلة كلها (للاختيارية) أو نفشل
      const planned = [];
      for (const weight of WEIGHTS) {
        for (const subset of SUBSETS) {
          const src = path.join(pkg.dir, "files", `${f.pkg}-${subset}-${weight}-normal.woff2`);
          planned.push({ src, file: `${f.pkg}-${subset}-${weight}.woff2`, weight, subset });
        }
      }
      const missing = planned.filter((p) => !fs.existsSync(p.src));
      if (missing.length) {
        const msg = `ملفات ناقصة في ${f.pkg}: ${missing.map((m) => path.basename(m.src)).join(", ")}`;
        if (f.optional) {
          console.log(`تخطّي ${f.family}: ${msg}`);
          continue;
        }
        throw new Error(msg);
      }

      for (const p of planned) {
        fs.copyFileSync(p.src, path.join(OUT, p.file));
        entries.push({ family: f.family, file: p.file, weight: p.weight, subset: p.subset });
      }
      const license = path.join(pkg.dir, "LICENSE");
      if (fs.existsSync(license)) fs.copyFileSync(license, path.join(OUT, "licenses", `${f.pkg}-LICENSE.txt`));
      credits.push({ family: f.family, pkg: f.pkg, version: pkg.version });
      console.log(`  + ${f.family} ${pkg.version} (${planned.length} ملفات)`);
    }

    if (!entries.length) throw new Error("لم يُنزَّل أي خط.");
    fs.writeFileSync(path.join(OUT, "fonts.css"), buildFontFaceCss(entries));
    const rows = credits.map((c) => `| ${c.family} | @fontsource/${c.pkg}@${c.version} | SIL OFL 1.1 |`);
    fs.writeFileSync(path.join(OUT, "LICENSES.md"), [
      "# الخطوط المرفقة",
      "",
      "كل الخطوط هنا مرخّصة بـ SIL Open Font License 1.1. نص الرخصة لكل حزمة في مجلد licenses/.",
      "",
      "| الخط | المصدر | الرخصة |",
      "|---|---|---|",
      ...rows,
      "",
      "الملفات تُولَّد بـ scripts/fetch-fonts.js.",
      "",
    ].join("\n"));
    console.log(`تم: ${entries.length} ملف خط في ${credits.length} عائلة.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { buildFontFaceCss, FAMILIES, UNICODE_RANGE, WEIGHTS, SUBSETS };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
