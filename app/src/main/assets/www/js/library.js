/*
 * مكتبة الخلفيات: ملف backgrounds/manifest.json هو مصدر الحقيقة.
 * كل عنصر لازم يكون له ترخيص ومصدر ومؤلف، وإلا ما يظهر في التطبيق.
 * المكتبة فاضية افتراضياً لأننا ما نضم صور أو فيديوهات بدون ترخيص مؤكد.
 */
(function (root) {
  "use strict";

  const CATEGORIES = {
    mountains: "جبال",
    oceans: "محيطات وبحار",
    forests: "غابات",
    waterfalls: "شلالات",
    deserts: "صحاري",
    rain: "مطر",
    clouds: "غيوم",
    sunrise: "شروق",
    sunset: "غروب",
    nightsky: "سماء ليلية",
    stars: "نجوم",
    mosques: "مساجد",
    nature: "طبيعة",
    minimal: "بسيط",
  };
  const BASE = "backgrounds/";
  const TYPES = ["image", "video"];

  // يتحقق من كل عنصر ويرجّع العناصر الصالحة مع أخطاء العناصر المرفوضة
  function validateManifest(data) {
    const raw = data && Array.isArray(data.items) ? data.items : [];
    const seen = new Set();
    const items = [];
    const errors = [];
    for (const it of raw) {
      const problems = [];
      if (!it || typeof it.id !== "string" || !it.id || seen.has(it.id)) problems.push("id");
      if (!it || !CATEGORIES[it.category]) problems.push("category");
      if (!it || !TYPES.includes(it.type)) problems.push("type");
      if (!it || typeof it.file !== "string" || !it.file || it.file.startsWith("/") || it.file.includes("..")) problems.push("file");
      if (!it || !it.license || !it.source || !it.author) problems.push("license");
      if (problems.length) {
        errors.push({ id: it && it.id ? String(it.id) : "?", problems });
      } else {
        seen.add(it.id);
        items.push({
          id: it.id,
          title: String(it.title || it.id),
          category: it.category,
          type: it.type,
          file: it.file,
          license: String(it.license),
          source: String(it.source),
          author: String(it.author),
        });
      }
    }
    return { items, errors };
  }

  async function loadManifest() {
    try {
      const res = await fetch(BASE + "manifest.json", { cache: "no-cache" });
      if (!res.ok) return { items: [], errors: [] };
      return validateManifest(await res.json());
    } catch (_) {
      return { items: [], errors: [{ id: "manifest", problems: ["load"] }] };
    }
  }

  const itemUrl = (item) => BASE + item.file;

  root.InabaLibrary = { CATEGORIES, validateManifest, loadManifest, itemUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = root.InabaLibrary;
})(typeof window !== "undefined" ? window : globalThis);
