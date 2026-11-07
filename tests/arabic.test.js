// اختبارات محرك البحث: تشغيل بـ `node --test tests/`
// النصوص هنا تجريبية (ليست من القرآن) حتى ما نعتمد على نص مكتوب من الذاكرة.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../app/src/main/assets/www/js/arabic.js");

const verses = [
  { surah: 1, ayah: 1, text: "نَصٌّ تَجْرِيبِيٌّ أَوَّلُ" },
  { surah: 1, ayah: 2, text: "كَلِمَةٌ مُمَيَّزَةٌ هُنَا" },
  { surah: 2, ayah: 1, text: "إِنَّ الْمُجَرَّبَ مَعَ الْكِتَابَةِ" },
  { surah: 2, ayah: 2, text: "سَلَامٌ عَلَى الْمَكْتَبَةِ الْجَدِيدَةِ" },
  { surah: 3, ayah: 1, text: "آيَةٌ تَحْتَوِي عَلَى تَجْرِيبٍ" },
];
const index = A.buildIndex(verses);

test("normalize removes diacritics", () => {
  assert.equal(A.normalize("نَصٌّ تَجْرِيبِيٌّ"), "نص تجريبي");
});

test("normalize unifies alef, ya and ta marbuta forms", () => {
  assert.equal(A.normalize("إِنَّ آيَةٌ"), "ان ايه");
  assert.equal(A.normalize("مدرسة"), A.normalize("مَدْرَسَه"));
  assert.equal(A.normalize("ٱلرَّحْمَٰن"), "الرحمن");
});

test("normalize keeps only Arabic letters and single spaces", () => {
  assert.equal(A.normalize("  كلمة 123 abc   أخرى  "), "كلمه اخري");
});

test("search matches a full phrase without diacritics", () => {
  const res = A.search(index, "نص تجريبي");
  assert.ok(res.length > 0);
  assert.deepEqual([res[0].surah, res[0].ayah], [1, 1]);
});

test("search matches a partial word", () => {
  const keys = A.search(index, "تجريب").map((r) => `${r.surah}:${r.ayah}`);
  assert.ok(keys.includes("1:1"), "تجريبي يحتوي تجريب");
  assert.ok(keys.includes("3:1"), "كلمة تجريب نفسها");
  assert.ok(!keys.includes("2:1"), "المجرب لا تحتوي تجريب");
});

test("search matches with a ta marbuta / ha spelling difference", () => {
  const res = A.search(index, "المكتبه");
  assert.ok(res.some((r) => r.surah === 2 && r.ayah === 2));
});

test("search tolerates a one-letter extra in a long word", () => {
  const res = A.search(index, "الجدييدة");
  assert.ok(res.some((r) => r.surah === 2 && r.ayah === 2));
});

test("search requires every query word to match", () => {
  assert.equal(A.search(index, "تجريب زائد").length, 0);
});

test("search returns surah and verse numbers with the text", () => {
  const [first] = A.search(index, "الكتابة");
  assert.equal(first.surah, 2);
  assert.equal(first.ayah, 1);
  assert.equal(first.text, verses[2].text);
});

test("empty or symbol-only query returns nothing", () => {
  assert.deepEqual(A.search(index, "   "), []);
  assert.deepEqual(A.search(index, "123 ..."), []);
});

test("results respect the limit", () => {
  assert.equal(A.search(index, "تجريب", 1).length, 1);
});

test("typo budget grows with word length", () => {
  assert.equal(A.allowedEdits("كتب"), 0);
  assert.equal(A.allowedEdits("كتاب"), 1);
  assert.equal(A.allowedEdits("مكتبهات"), 2);
});

test("plainName removes tashkeel and the سورة prefix for file names", () => {
  // اسم تجريبي بنفس الشكل (ليس نصاً قرآنياً منقولاً من الذاكرة)
  assert.equal(A.plainName("سُورَةُ ٱلْمِثَالِ"), "المثال");
  assert.equal(A.plainName("سُورَةُ ٱلْبَيْتِ"), "البيت");
  assert.equal(A.plainName("  اسم بلا تشكيل  "), "اسم بلا تشكيل");
  assert.equal(A.plainName(""), "");
  assert.equal(A.plainName(null), "");
});
