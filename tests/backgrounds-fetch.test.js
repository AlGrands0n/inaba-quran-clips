// اختبارات فلترة التراخيص وتحويل نتائج كومنز إلى عناصر المانيفست.
// لا تتصل بالشبكة: البيانات هنا تجريبية وليست ملفات حقيقية.
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../scripts/fetch-backgrounds.js");
const LIB = require("../app/src/main/assets/www/js/library.js");

test("classifyLicense accepts CC0, public domain and any CC BY version", () => {
  assert.equal(F.classifyLicense("CC0").name, "CC0 1.0");
  assert.equal(F.classifyLicense("Public domain").name, "Public domain");
  assert.equal(F.classifyLicense("CC BY 4.0").url, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(F.classifyLicense("CC BY 2.5").name, "CC BY 2.5");
  assert.equal(F.classifyLicense("CC BY 3.0").attribution, true);
});

test("classifyLicense rejects share-alike, non-commercial, no-derivatives and copyleft", () => {
  for (const s of ["CC BY-SA 4.0", "CC BY-NC 2.0", "CC BY-ND 3.0", "CC BY-NC-SA 4.0", "GFDL", "", undefined, "All rights reserved"]) {
    assert.equal(F.classifyLicense(s), null, `يجب رفض: ${s}`);
  }
});

test("plainText strips tags and decodes common entities", () => {
  assert.equal(F.plainText('<a href="https://example.org">اسم &amp; لقب</a><br>'), "اسم & لقب");
  assert.equal(F.plainText("A&nbsp;&quot;B&quot; &#39;C&#39;"), "A \"B\" 'C'");
  assert.equal(F.plainText(undefined), "");
});

test("slugify makes ASCII names and never returns an empty name", () => {
  assert.equal(F.slugify("Test Mountain 01"), "test-mountain-01");
  assert.equal(F.slugify("Café Été"), "cafe-ete");
  assert.equal(F.slugify("!!!"), "item");
});

// صورة تجريبية بحقول مطابقة لرد ويكيميديا (formatversion=2)
function photoPage(overrides = {}) {
  const base = {
    title: "File:Test mountain 01.jpg",
    imageinfo: [{
      url: "https://upload.example.org/original.jpg",
      thumburl: "https://upload.example.org/thumb.jpg",
      descriptionurl: "https://commons.example.org/wiki/File:Test_mountain_01.jpg",
      mime: "image/jpeg",
      mediatype: "BITMAP",
      width: 2400,
      height: 1600,
      size: 1000,
      extmetadata: {
        LicenseShortName: { value: "CC BY 4.0" },
        Artist: { value: "<a href=\"https://example.org/u\">Example Author</a>" },
      },
    }],
  };
  return { ...base, ...overrides };
}

test("buildCandidate turns an accepted photo into a library item", () => {
  const cand = F.buildCandidate(photoPage(), "mountains");
  assert.equal(cand.kind, "image");
  assert.equal(cand.url, "https://upload.example.org/thumb.jpg");
  assert.equal(cand.item.id, "commons-test-mountain-01");
  assert.equal(cand.item.file, "mountains/test-mountain-01.jpg");
  assert.equal(cand.item.author, "Example Author");
  assert.equal(cand.item.license, "CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/");
  assert.equal(cand.item.source, "https://commons.example.org/wiki/File:Test_mountain_01.jpg");
  // المانيفست الناتج لازم يمر من التحقق الذي تستخدمه المكتبة في التطبيق
  const v = LIB.validateManifest({ items: [cand.item] });
  assert.deepEqual(v.errors, []);
  assert.equal(v.items.length, 1);
});

test("buildCandidate skips a CC BY photo without an author", () => {
  const page = photoPage();
  page.imageinfo[0].extmetadata.Artist = { value: "" };
  assert.match(F.buildCandidate(page, "mountains").skip, /اسم مؤلف/);
});

test("buildCandidate skips a file with a non-commercial license", () => {
  const page = photoPage();
  page.imageinfo[0].extmetadata.LicenseShortName = { value: "CC BY-NC 2.0" };
  assert.ok(F.buildCandidate(page, "mountains").skip);
});

test("buildCandidate skips small photos and short or low-resolution videos", () => {
  const small = photoPage();
  small.imageinfo[0].width = 800;
  assert.match(F.buildCandidate(small, "mountains").skip, /صغيرة/);

  const video = photoPage({ title: "File:Test waves.webm" });
  Object.assign(video.imageinfo[0], { mediatype: "VIDEO", mime: "video/webm", width: 1920, duration: 2, size: 5000 });
  assert.match(F.buildCandidate(video, "oceans").skip, /قصير/);

  video.imageinfo[0].duration = 12;
  video.imageinfo[0].width = 640;
  assert.match(F.buildCandidate(video, "oceans").skip, /دقة صغيرة/);
});

test("buildCandidate accepts a long enough HD video and names it .mp4", () => {
  const video = photoPage({ title: "File:Test waves.webm" });
  Object.assign(video.imageinfo[0], { mediatype: "VIDEO", mime: "video/webm", width: 1920, duration: 12, size: 5000, url: "https://upload.example.org/waves.webm" });
  const cand = F.buildCandidate(video, "oceans");
  assert.equal(cand.kind, "video");
  assert.equal(cand.url, "https://upload.example.org/waves.webm");
  assert.equal(cand.item.file, "oceans/test-waves.mp4");
  assert.deepEqual(LIB.validateManifest({ items: [cand.item] }).errors, []);
});

test("renderLicenseTable escapes pipes and lists every item", () => {
  const table = F.renderLicenseTable([{
    title: "A|B", category: "mountains", type: "image", author: "X", license: "CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/", source: "https://example.org/s",
  }]);
  const lines = table.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[2], /A\/B/);
  assert.match(lines[2], /جبال/);
});

test("every configured category is a known library category", () => {
  for (const key of Object.keys(F.SOURCES)) {
    assert.ok(LIB.CATEGORIES[key], `الفئة ${key} غير معروفة في المكتبة`);
  }
});
