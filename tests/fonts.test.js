// اختبارات الخطوط: CSS المولَّد، وأن كل خط يعرضه المحرر موجود في قائمة التنزيل.
// لا تتصل بالشبكة.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const F = require("../scripts/fetch-fonts.js");

const WWW = path.join(__dirname, "..", "app", "src", "main", "assets", "www");

test("buildFontFaceCss writes one block per file with a relative url and unicode-range", () => {
  const css = F.buildFontFaceCss([
    { family: "Amiri", file: "amiri-arabic-400.woff2", weight: 400, subset: "arabic" },
    { family: "Amiri", file: "amiri-latin-700.woff2", weight: 700, subset: "latin" },
  ]);
  const blocks = css.match(/@font-face \{[\s\S]*?\}/g);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /font-family: "Amiri";/);
  assert.match(blocks[0], /font-weight: 400;/);
  assert.match(blocks[0], /src: url\("amiri-arabic-400\.woff2"\) format\("woff2"\);/);
  assert.match(blocks[0], /unicode-range: U\+0600-06FF/);
  assert.match(blocks[1], /font-weight: 700;/);
  assert.match(blocks[1], /unicode-range: U\+0000-00FF/);
  // لا مسار مطلق ولا رابط خارجي
  assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(css, /url\("\//);
});

test("every family offered by the editor is in the fetch list", () => {
  const html = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
  const names = new Set(F.FAMILIES.map((f) => f.family));
  for (const name of ["Amiri Quran", "Amiri", "Scheherazade New", "Noto Naskh Arabic"]) {
    assert.ok(html.includes(`<option value="${name}">`), `المحرر لا يعرض ${name}`);
    assert.ok(names.has(name), `${name} غير موجود في قائمة التنزيل`);
  }
});

test("the app no longer loads fonts from the network", () => {
  const html = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(html, /href="fonts\/fonts\.css"/);
});
