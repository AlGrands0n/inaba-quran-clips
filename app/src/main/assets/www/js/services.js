/*
 * طبقة الخدمات الخارجية. كل الاتصال بالإنترنت هنا فقط.
 * - نص القرآن (Uthmani) والتفسير والترجمة من alquran.cloud.
 * - القراء وتوقيت الآيات والصوت من MP3Quran.
 * ما نولّد أي نص قرآني أو تفسير أو توقيت بأنفسنا. إذا فشل الجلب، نعرض الخطأ.
 */
(function (root) {
  "use strict";

  const QURAN_API = "https://api.alquran.cloud/v1";
  const MP3Q_API = "https://www.mp3quran.net/api/v3";
  const CACHE_VERSION = "v1";
  const READERS_TTL_MS = 7 * 24 * 3600 * 1000;
  const AUDIO_CACHE = "inaba-audio-v1";

  // معرّفات الإصدارات في alquran.cloud. أكّدها مرة من قائمة /edition قبل النشر التجاري.
  const TAFSIR_EDITIONS = [
    { id: "ar.muyassar", label: "التفسير الميسر" },
  ];
  const TRANSLATIONS = [
    { id: "en.sahih", label: "English — Saheeh International", rtl: false, family: "Noto Sans" },
    { id: "fr.hamidullah", label: "Français — Hamidullah", rtl: false, family: "Noto Sans" },
    { id: "tr.diyanet", label: "Türkçe — Diyanet", rtl: false, family: "Noto Sans" },
    { id: "ur.jalandhry", label: "اردو — جالندھری", rtl: true, family: "Noto Naskh Arabic" },
    { id: "id.indonesian", label: "Bahasa Indonesia — Kemenag", rtl: false, family: "Noto Sans" },
  ];

  const BASMALA = ["بسم", "الله", "الرحمن", "الرحيم"];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // جلب JSON مع إعادة المحاولة. أخطاء 4xx (ما عدا 429) ما تتكرر لأنها بتفشل دائماً.
  async function fetchJson(url, attempts = 3, timeoutMs = 20000) {
    let lastErr = new Error("تعذر الاتصال بالخادم.");
    for (let i = 1; i <= attempts; i++) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
        if (res.ok) return await res.json();
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        if (err.fatal) throw err;
        lastErr = err.name === "AbortError" ? new Error("انتهت مهلة الاتصال.") : err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (i < attempts) await sleep(700 * i);
    }
    throw lastErr;
  }

  // يحذف البسملة من أول آية (ما عدا الفاتحة والتوبة) للعرض فقط
  const normWord = (w) => w.replace(/[ً-ٰٟۖ-ۭ]/g, "").replace(/ٱ/g, "ا").replace(/[^ء-ي]/g, "");
  function displayText(surahNo, ayahNo, text) {
    const t = String(text).trim();
    if (surahNo === 1 || surahNo === 9 || ayahNo !== 1) return t;
    const words = t.split(/\s+/);
    if (words.length > 4 && BASMALA.every((b, i) => normWord(words[i]) === b)) return words.slice(4).join(" ");
    return t;
  }

  // ---------- نص القرآن ----------
  async function loadQuran() {
    const key = `quran:${CACHE_VERSION}`;
    const cached = await root.InabaDB.cacheGet(key).catch(() => null);
    if (cached && Array.isArray(cached.surahs)) return cached;

    const json = await fetchJson(`${QURAN_API}/quran/quran-uthmani`);
    const surahs = json.data.surahs.map((s) => ({
      number: s.number,
      name: s.name,
      englishName: s.englishName,
      count: s.ayahs.length,
      ayahs: s.ayahs.map((a) => ({ number: a.numberInSurah, text: displayText(s.number, a.numberInSurah, a.text) })),
    }));
    const data = { surahs };
    if (surahs.length !== 114) throw new Error("بيانات القرآن غير مكتملة (عدد السور ليس 114).");
    await root.InabaDB.cachePut(key, data).catch(() => {});
    return data;
  }

  // ---------- التفسير والترجمة (لكل سورة) ----------
  async function loadEdition(editionId, surahNo) {
    const key = `ed:${editionId}:${surahNo}:${CACHE_VERSION}`;
    const cached = await root.InabaDB.cacheGet(key).catch(() => null);
    if (cached) return cached;
    const json = await fetchJson(`${QURAN_API}/surah/${surahNo}/${editionId}`);
    const map = {};
    for (const a of json.data.ayahs) map[a.numberInSurah] = String(a.text).trim();
    await root.InabaDB.cachePut(key, map).catch(() => {});
    return map;
  }

  // ---------- MP3Quran ----------
  async function loadReaders() {
    const cached = await root.InabaDB.cacheGet(`readers:${CACHE_VERSION}`).catch(() => null);
    if (cached && Date.now() - cached.savedAt < READERS_TTL_MS && Array.isArray(cached.value)) return cached.value;
    const list = await fetchJson(`${MP3Q_API}/ayat_timing/reads`);
    const readers = Array.isArray(list) ? list : [];
    await root.InabaDB.cachePut(`readers:${CACHE_VERSION}`, readers).catch(() => {});
    return readers;
  }

  async function loadTiming(surahNo, readerId) {
    const json = await fetchJson(`${MP3Q_API}/ayat_timing?surah=${surahNo}&read=${encodeURIComponent(readerId)}`);
    return Array.isArray(json) ? json : [];
  }

  function audioUrlFor(reader, surahNo) {
    if (!reader || !reader.folder_url) return null;
    const base = String(reader.folder_url).replace(/\/?$/, "/");
    return base + String(surahNo).padStart(3, "0") + ".mp3";
  }

  // يحوّل توقيت MP3Quran إلى {رقم الآية: ثانية}. وحدة الوقت (ثانية أو ملّي ثانية) تتحدد من مدة الصوت.
  function normalizeTiming(list, durationSec) {
    // نكشف الوحدة من أكبر قيمة (بداية أو نهاية): إذا تجاوزت مدة الصوت بكثير فهي ملّي ثانية
    const maxVal = Math.max(0, ...list.map((x) => Math.max(Number(x.end_time) || 0, Number(x.start_time) || 0)));
    const factor = durationSec && maxVal > durationSec * 1.5 ? 1000 : 1;
    const starts = {};
    for (const x of list) {
      const n = Number(x.ayah);
      const s = Number(x.start_time);
      if (Number.isFinite(n) && Number.isFinite(s)) starts[n] = Math.round((s / factor) * 100) / 100;
    }
    return starts;
  }

  // تحميل الملف كاملاً (حتى نقدر نصدّر بدون مشاكل CORS). إذا منع السيرفر ذلك، نرجع للتشغيل المباشر للمعاينة فقط.
  // useCache: يحفظ الصوت في Cache API ويرجع له في المرة الجاية. يفعّله المستخدم من الإعدادات.
  async function fetchAudioBlob(url, useCache = false) {
    const hasCache = !!useCache && typeof root.caches !== "undefined";
    if (hasCache) {
      try {
        const hit = await (await root.caches.open(AUDIO_CACHE)).match(url);
        if (hit) return { blob: await hit.blob(), direct: false, cached: true };
      } catch (_) { /* نتجاهل الكاش ونجلب من الشبكة */ }
    }
    let lastErr = null;
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        // نستنسخ الرد قبل قراءة الجسم، وإلا clone() يفشل بعد استهلاك الجسم
        const copy = hasCache ? res.clone() : null;
        if (copy) root.caches.open(AUDIO_CACHE).then((c) => c.put(url, copy)).catch(() => {});
        return { blob: await res.blob(), direct: false, cached: false };
      } catch (err) {
        if (err.fatal) throw err;
        lastErr = err; // انقطاع أو خطأ شبكة: نعيد المحاولة
        await sleep(700 * i);
      }
    }
    return { blob: null, direct: true, reason: lastErr && lastErr.message };
  }

  root.InabaServices = {
    TAFSIR_EDITIONS,
    TRANSLATIONS,
    fetchJson,
    loadQuran,
    loadEdition,
    loadReaders,
    loadTiming,
    audioUrlFor,
    normalizeTiming,
    fetchAudioBlob,
    displayText,
    AUDIO_CACHE,
  };
})(typeof window !== "undefined" ? window : globalThis);
