/*
 * محرّك البحث في نص القرآن.
 * - يطبّع النص: يشيل التشكيل والعلامات القرآنية، ويوحّد الألفات والياء والتاء المربوطة، فالبحث يشتغل بدون تشكيل.
 * - يبحث بالآية كاملة، أو بجزء من كلمة، أو بكلمات متفرقة (كل الكلمات لازم تكون موجودة).
 * - يتحمّل خطأ إملائي بسيط (حرف زايد أو ناقص أو مبدّل) في الكلمات الطويلة.
 * ملاحظة: الملف بدون اعتماد على المتصفح، فيقدر يتجرّب في Node.
 */
(function (root) {
  "use strict";

  // التشكيل وعلامات الوقف والتطويل والعلامات القرآنية الصغيرة
  const MARKS = /[ؐ-ؚـً-ٰٟۖ-ۭ࣓-ࣿ]/g;

  function normalize(text) {
    return String(text || "")
      .replace(MARKS, "")
      .replace(/[آأإٱ-ٳ]/g, "ا") // آ أ إ ٱ ٲ ٳ -> ا
      .replace(/ؤ/g, "و") // ؤ -> و
      .replace(/[ئى]/g, "ي") // ئ ى -> ي
      .replace(/ة/g, "ه") // ة -> ه
      .replace(/[^ء-غف-ي\s]/g, "") // حروف عربية فقط
      .replace(/\s+/g, " ")
      .trim();
  }

  // هل المسافة بين النصين (تعديل: حذف/إضافة/تبديل) أقل من أو تساوي max؟ مع إيقاف مبكر
  function withinEdits(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = new Array(b.length + 1);
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  }

  // عدد الأخطاء المسموحة حسب طول الكلمة: الكلمات القصيرة ما تتحمّل أخطاء حتى ما تعطي نتائج عشوائية
  function allowedEdits(word) {
    return word.length >= 6 ? 2 : word.length >= 4 ? 1 : 0;
  }

  // items: [{surah, ayah, text}]
  function buildIndex(verses) {
    const items = [];
    const postings = new Map(); // كلمة -> [رقم العنصر]
    for (const v of verses) {
      const norm = normalize(v.text);
      const id = items.length;
      const words = norm ? norm.split(" ") : [];
      items.push({ surah: v.surah, ayah: v.ayah, text: v.text, norm, words });
      for (const w of new Set(words)) {
        let list = postings.get(w);
        if (!list) postings.set(w, (list = []));
        list.push(id);
      }
    }
    return { items, vocab: [...postings.keys()], postings };
  }

  // يرجّع النتائج مرتبة بالأقرب أولاً: التطابق الكامل للعبارة أعلى، ثم عدد الكلمات المطابقة
  function search(index, query, limit = 50) {
    const q = normalize(query);
    if (!q) return [];
    const qWords = q.split(" ");

    const perWord = qWords.map((w) => {
      const hits = new Map(); // رقم العنصر -> أعلى وزن
      const edits = allowedEdits(w);
      for (const v of index.vocab) {
        let weight = 0;
        if (v === w) weight = 1;
        else if (w.length >= 2 && v.includes(w)) weight = 0.9; // جزء من كلمة
        else if (edits && (withinEdits(w, v, edits) || withinEdits(w, v.slice(0, w.length), edits))) weight = 0.6;
        if (!weight) continue;
        for (const id of index.postings.get(v)) {
          if ((hits.get(id) || 0) < weight) hits.set(id, weight);
        }
      }
      return hits;
    });

    const smallest = perWord.reduce((a, b) => (b.size < a.size ? b : a));
    const results = [];
    for (const id of smallest.keys()) {
      let total = 0;
      let ok = true;
      for (const hits of perWord) {
        const weight = hits.get(id);
        if (!weight) {
          ok = false;
          break;
        }
        total += weight;
      }
      if (!ok) continue;
      const item = index.items[id];
      const score = total / qWords.length + (item.norm.includes(q) ? 1 : 0);
      results.push({ surah: item.surah, ayah: item.ayah, text: item.text, score });
    }

    results.sort((a, b) => b.score - a.score || a.surah - b.surah || a.ayah - b.ayah);
    return results.slice(0, limit);
  }

  const api = { normalize, withinEdits, allowedEdits, buildIndex, search };
  root.InabaArabic = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
