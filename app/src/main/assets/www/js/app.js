/*
 * واجهة صانع المقاطع: ثلاث خطوات (اختيار الآيات والتلاوة، التصميم، المعاينة والتصدير)،
 * والمسودات، والتصدير.
 * ملاحظة: ما نستخدم alert/confirm/prompt لأن أندرويد WebView ما يعرضها بدون إعداد إضافي.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const A = window.InabaArabic;
  const DB = window.InabaDB;
  const SV = window.InabaServices;
  const R = window.InabaRenderer;
  const { toAr } = R;
  const nativeBridge = window.InabaBridge || null;
  const STORE = window.InabaStore;
  const LIB = window.InabaLibrary;
  const USER_FONT = "InabaUserFont"; // اسم الخط المرفوع من المستخدم (يُسجَّل بعد التحميل)

  const audio = $("audio");
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");

  const EDITOR_KEY = "inaba.editor.v2";
  const MAX_VERSES = 286;
  const MAX_SECONDS = 300;
  const EST_SECONDS_PER_VERSE = 6;
  const SAVE_CHUNK = 3 * 256 * 1024;
  const ASPECTS = { "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5] };
  const PRESETS = {
    classic: { color: "#e8c968", shadow: true, boxOn: false, frame: "gold", numberStyle: "circle", fontFamily: "Amiri Quran" },
    ivory: { color: "#f7f1e1", shadow: true, boxOn: true, boxColor: "#0c1a22", boxOpacity: 35, frame: "none", numberStyle: "paren", fontFamily: "Scheherazade New" },
    emerald: { color: "#cfeee6", shadow: false, boxOn: true, boxColor: "#06120f", boxOpacity: 45, frame: "double", numberStyle: "circle", fontFamily: "Amiri" },
    minimal: { color: "#ffffff", shadow: true, boxOn: false, frame: "none", numberStyle: "paren", fontFamily: "Noto Naskh Arabic" },
  };

  // ---------- الحالة ----------
  const defaults = () => ({
    step: 1,
    surah: 1,
    from: 1,
    to: 7,
    volume: 100,
    offsetMs: 0,
    readerId: "",
    readerName: "",
    audioKind: "none", // none | remote | file
    audioName: "",
    starts: {}, // رقم الآية -> ثانية (قبل الإزاحة)
    timingSource: "", // mp3quran | manual
    title: "",
    reciterName: "",
    brand: "إنابة",
    lightMode: false,
    design: {
      aspect: "9:16", customW: 1080, customH: 1920, res: 1080,
      textPos: "center", customY: 50, fontFamily: "Amiri Quran", fontSize: 100,
      color: "#ffffff", opacity: 100, lineHeight: 180, letterSpacing: 0, align: "center",
      shadow: true, boxOn: false, boxColor: "#0c1a22", boxOpacity: 40,
      frame: "none", numberStyle: "circle", fadeMs: 400,
    },
    trans: { on: false, edition: "en.sahih", size: 100, color: "#ffffff", pos: "below", align: "center" },
    tafsir: { on: false, edition: "ar.muyassar", family: "Noto Naskh Arabic", size: 100, color: "#eaf2f0", pos: "bottom", align: "center", bgOpacity: 35 },
    bg: {
      items: [], // {id, name, type: image|video|solid, color, fav}
      interval: 8, motion: "in", amount: 50,
      brightness: 100, contrast: 100, saturation: 100, blur: 0, darkness: 35, overlay: 30,
      onlyFav: false, solidColor: "#0c1a22",
    },
  });

  let S = defaults();

  const RT = {
    quran: null,
    custom: null, // نص مُدخل يدوياً (فقط إذا فشل تحميل القرآن)
    index: null,
    readers: [],
    version: 1,
    audioUrl: null,
    audioBlob: null,
    audioDirect: false,
    pendingTiming: null,
    bgRuntime: new Map(), // id -> {el, url, blob, type}
    tafsirMap: null, tafsirKey: "",
    transMap: null, transKey: "",
    exporting: false, recorder: null, chunks: [], cancelled: false, exportStream: null, exportMime: "",
    exportStart: 0, exportEnd: 0, lastError: null,
    resultUrl: null, lastBlob: null,
    currentDraftId: null,
    activeNum: null,
    seeking: false,
    persistTimer: null,
    msgTimer: null,
    lib: { items: [], errors: [] }, // مكتبة الخلفيات (من manifest.json بعد التحقق)
    userFace: null, // FontFace للخط المرفوع من المستخدم
    lastBgIdx: -2,
    lastAutoTitle: "",
  };

  // ---------- مساعدات ----------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const round2 = (x) => Math.round(x * 100) / 100;
  const uid = () => (root().crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  function root() { return window; }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
  }
  // يدمج الإعدادات المحفوظة فوق الافتراضي. الخرائط (مثل التوقيت) تنسخ مفاتيحها كما هي.
  function mergeDeep(target, src) {
    for (const k of Object.keys(src || {})) {
      const v = src[k];
      const cur = target[k];
      if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
        mergeDeep(cur, v);
      } else if (Array.isArray(v) || (v && typeof v === "object")) {
        target[k] = v;
      } else if (cur === undefined || typeof v === typeof cur) {
        target[k] = v;
      }
    }
    return target;
  }

  function toast(text, kind = "info") {
    const box = $("toast");
    box.textContent = text;
    box.dataset.kind = kind;
    box.hidden = false;
    clearTimeout(RT.msgTimer);
    RT.msgTimer = setTimeout(() => { box.hidden = true; }, kind === "error" ? 6000 : 3500);
  }

  function setStatus(id, text, kind = "") {
    const el = $(id);
    el.textContent = text || "";
    el.dataset.kind = kind;
    if (id === "quranStatus") el.hidden = !text;
  }

  // ---------- بيانات القرآن والنطاق ----------
  function surahData(n = S.surah) {
    if (n === 0) return RT.custom;
    if (!RT.quran) return null;
    return RT.quran.surahs[n - 1] || null;
  }

  function surahName(n = S.surah) {
    const s = surahData(n);
    return s ? s.name : "";
  }

  function normalizeRange() {
    const s = surahData();
    const count = s ? s.count : 7;
    S.surah = clamp(Math.round(S.surah) || 0, RT.custom ? 0 : 1, 114);
    S.from = clamp(Math.round(S.from) || 1, 1, count);
    S.to = clamp(Math.round(S.to) || S.from, S.from, count);
  }

  function rangeVerses() {
    const s = surahData();
    if (!s) return [];
    return s.ayahs.slice(S.from - 1, S.to);
  }

  function audioDuration() {
    const d = audio.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }
  const audioReady = () => audioDuration() > 0;

  function translationInfo() {
    return SV.TRANSLATIONS.find((t) => t.id === S.trans.edition) || SV.TRANSLATIONS[0];
  }

  // مفاتيح الكاش الحالية للتفسير والترجمة (إذا تغيّرت السورة أو الإصدار تصير القيمة قديمة)
  const tafsirKeyNow = () => `${S.tafsir.edition}:${S.surah}`;
  const transKeyNow = () => `${S.trans.edition}:${S.surah}`;

  // يبني المقاطع الزمنية للآيات المختارة فقط. نهاية كل آية = بداية الآية المعلّمة التالية (حتى لو خارج النطاق).
  function buildSegments() {
    const s = surahData();
    if (!s || S.surah === 0) return [];
    const dur = audioDuration();
    const off = S.offsetMs / 1000;
    const marked = [];
    for (let n = 1; n <= s.count; n++) {
      if (isNum(S.starts[n])) marked.push({ n, start: Math.max(0, S.starts[n] + off) });
    }
    const gaps = [];
    for (let i = 0; i + 1 < marked.length; i++) {
      const g = marked[i + 1].start - marked[i].start;
      if (g > 0) gaps.push(g);
    }
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : EST_SECONDS_PER_VERSE;

    const trReady = S.trans.on && RT.transKey === transKeyNow() && RT.transMap;
    const tfReady = S.tafsir.on && RT.tafsirKey === tafsirKeyNow() && RT.tafsirMap;
    const out = [];
    marked.forEach((cur, i) => {
      if (cur.n < S.from || cur.n > S.to) return;
      const next = marked[i + 1];
      let end;
      let endKnown = true;
      if (next) end = next.start;
      else if (cur.n === s.count && dur > 0) end = dur;
      else {
        end = cur.start + avg;
        endKnown = false;
      }
      if (dur > 0) end = Math.min(end, dur);
      end = Math.max(end, cur.start + 0.2);
      out.push({
        number: cur.n,
        surah: S.surah,
        text: s.ayahs[cur.n - 1].text,
        start: cur.start,
        end,
        endKnown,
        translation: trReady ? RT.transMap[cur.n] || null : null,
        tafsir: tfReady ? RT.tafsirMap[cur.n] || null : null,
      });
    });
    return out;
  }

  function selectionInfo() {
    const vs = rangeVerses();
    const n = vs.length;
    const segs = buildSegments();
    const timed = segs.length;
    if (n && timed === n && segs[segs.length - 1].endKnown) {
      return { n, timed, seconds: segs[segs.length - 1].end - segs[0].start, exact: true };
    }
    return { n, timed, seconds: n * EST_SECONDS_PER_VERSE, exact: false };
  }

  function dims() {
    const d = S.design;
    let w;
    let h;
    if (d.aspect === "custom") {
      w = clamp(d.customW, 240, 3840);
      h = clamp(d.customH, 240, 3840);
    } else {
      const [a, b] = ASPECTS[d.aspect] || [9, 16];
      const short = d.res;
      if (a < b) { w = short; h = (short * b) / a; }
      else if (a > b) { h = short; w = (short * a) / b; }
      else { w = short; h = short; }
    }
    const maxSide = S.lightMode ? 1280 : 3840;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(2, 2 * Math.round((w * scale) / 2));
    h = Math.max(2, 2 * Math.round((h * scale) / 2));
    return [w, h];
  }

  function activeBgItems() {
    let list = S.bg.items;
    if (S.bg.onlyFav) {
      const fav = list.filter((i) => isFav(i));
      if (fav.length) list = fav;
    }
    const out = [];
    for (const meta of list) {
      if (meta.type === "solid") {
        out.push({ type: "solid", color: meta.color });
        continue;
      }
      const rt = RT.bgRuntime.get(meta.id);
      if (rt) out.push({ type: meta.type, el: rt.el });
    }
    return out;
  }

  function buildScene() {
    const [w, h] = dims();
    const s = surahData();
    const tr = translationInfo();
    const segments = buildSegments();
    return {
      w,
      h,
      unit: Math.min(w, h),
      version: RT.version,
      light: S.lightMode,
      design: S.design,
      tafsir: {
        on: S.tafsir.on, family: S.tafsir.family, size: S.tafsir.size, color: S.tafsir.color,
        pos: S.tafsir.pos, align: S.tafsir.align, bgOpacity: S.tafsir.bgOpacity,
        label: "التفسير الميسر",
      },
      trans: {
        on: S.trans.on, family: tr.family, rtl: tr.rtl, size: S.trans.size,
        color: S.trans.color, pos: S.trans.pos, align: S.trans.align,
      },
      look: {
        brightness: S.bg.brightness, contrast: S.bg.contrast, saturation: S.bg.saturation,
        blur: S.bg.blur, darkness: S.bg.darkness, overlay: S.bg.overlay,
      },
      motion: { mode: S.bg.motion, amount: S.bg.amount / 100 },
      bg: { items: activeBgItems(), interval: S.bg.interval, fallback: S.bg.solidColor },
      segments,
      duration: audioDuration(),
      title: S.title.trim(),
      subtitle: s ? `سورة ${s.name} · الآيات ${toAr(S.from)} – ${toAr(S.to)}` : "",
      reciterName: S.reciterName.trim(),
      brand: S.brand.trim(),
      transLabel: S.trans.on ? `ترجمة معاني · ${tr.label}` : "",
    };
  }

  // ---------- الصوت ----------
  let audioCtx = null;
  let gainNode = null;
  let mediaDest = null;

  // يرجّع true إذا الرسم الصوتي جاهز. الصوت المباشر من موقع خارجي ما نقدر نوجّهه (CORS)، فيشتغل بدون رسم.
  function ensureAudioGraph() {
    if (RT.audioDirect) return false;
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audio);
      gainNode = audioCtx.createGain();
      mediaDest = audioCtx.createMediaStreamDestination();
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      gainNode.connect(mediaDest);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    applyVolume();
    return true;
  }

  function applyVolume() {
    const v = clamp(S.volume, 0, 100) / 100;
    if (gainNode) {
      gainNode.gain.value = v;
      audio.volume = 1;
    } else {
      audio.volume = v;
    }
  }

  function revokeAudioUrl() {
    if (RT.audioUrl && RT.audioUrl.startsWith("blob:")) URL.revokeObjectURL(RT.audioUrl);
    RT.audioUrl = null;
  }

  // ربط صوت بالمشغّل بدون مسح التوقيت (يُستخدم عند فتح مسودة)
  function attachAudio(url, blob, kind, name, direct = false) {
    revokeAudioUrl();
    RT.audioUrl = url;
    RT.audioBlob = blob || null;
    RT.audioDirect = !!direct;
    audio.pause();
    audio.src = url;
    audio.load();
    S.audioKind = kind;
    S.audioName = name || "";
  }

  // صوت جديد: نمسح التوقيت القديم لأنه ما يخص هذا الملف
  function setNewAudio(url, blob, kind, name, direct = false) {
    attachAudio(url, blob, kind, name, direct);
    S.starts = {};
    S.timingSource = "";
  }

  function waitAudioReady(ms) {
    return new Promise((resolve, reject) => {
      if (audio.readyState >= 3) return resolve();
      let timer = null;
      const ok = () => {
        if (audio.readyState >= 3) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener("canplay", ok);
        audio.removeEventListener("canplaythrough", ok);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("الصوت ما زال يتحمّل. انتظر لحظة ثم أعد المحاولة."));
      }, ms);
      audio.addEventListener("canplay", ok);
      audio.addEventListener("canplaythrough", ok);
    });
  }

  function seekTo(t) {
    return new Promise((resolve) => {
      if (Math.abs(audio.currentTime - t) < 0.01) return resolve();
      const done = () => {
        audio.removeEventListener("seeked", done);
        resolve();
      };
      audio.addEventListener("seeked", done);
      audio.currentTime = t;
      setTimeout(resolve, 1500);
    });
  }

  function stopPlayback() {
    audio.pause();
  }

  // ---------- التوقيت ----------
  function applyMp3Timing(list) {
    const starts = SV.normalizeTiming(list, audioDuration());
    const count = Object.keys(starts).length;
    if (!count) return false;
    S.starts = starts;
    S.timingSource = "mp3quran";
    const missing = [];
    for (let n = S.from; n <= S.to; n++) if (!isNum(starts[n])) missing.push(n);
    const note = missing.length ? ` ناقص توقيت للآيات: ${missing.map(toAr).join("، ")}.` : "";
    setStatus("mp3Status", `تم ربط التوقيت (${toAr(count)} آية في السورة).${note}`, missing.length ? "warn" : "ok");
    onChange("timing");
    return true;
  }

  // ---------- المحتوى الإضافي: التفسير والترجمة ----------
  async function ensureEditions(strict = false) {
    if (S.surah === 0) return;
    const jobs = [];
    if (S.tafsir.on && RT.tafsirKey !== tafsirKeyNow()) {
      const key = tafsirKeyNow();
      jobs.push(SV.loadEdition(S.tafsir.edition, S.surah).then((map) => {
        if (tafsirKeyNow() === key) { RT.tafsirMap = map; RT.tafsirKey = key; RT.version++; }
      }).catch((err) => { throw new Error(`تعذر تحميل التفسير (${err.message})`); }));
    }
    if (S.trans.on && RT.transKey !== transKeyNow()) {
      const key = transKeyNow();
      jobs.push(SV.loadEdition(S.trans.edition, S.surah).then((map) => {
        if (transKeyNow() === key) { RT.transMap = map; RT.transKey = key; RT.version++; }
      }).catch((err) => { throw new Error(`تعذر تحميل الترجمة (${err.message})`); }));
    }
    if (!jobs.length) return;
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      setStatus("editionStatus", failed.reason.message, "error");
      if (strict) throw failed.reason;
    } else {
      setStatus("editionStatus", "");
    }
  }

  function refreshEditions() {
    ensureEditions().catch(() => {});
  }

  // ---------- الواجهة: الخطوات والبحث والجداول ----------
  function goStep(n) {
    S.step = clamp(n, 1, 3);
    for (const p of document.querySelectorAll("[data-step-panel]")) {
      p.hidden = Number(p.dataset.stepPanel) !== S.step;
    }
    for (const b of document.querySelectorAll("[data-step]")) {
      b.classList.toggle("active", Number(b.dataset.step) === S.step);
    }
    if (S.step === 3) renderChecklist();
  }

  function renderSurahOptions() {
    const sel = $("surahSel");
    let html = "";
    if (RT.custom) html += `<option value="0">نص مُدخل يدوياً</option>`;
    if (RT.quran) {
      html += RT.quran.surahs.map((s) => `<option value="${s.number}">${toAr(s.number)} — ${esc(s.name)}</option>`).join("");
    }
    sel.innerHTML = html;
  }

  function renderSearch() {
    const q = $("searchQ").value;
    const list = $("searchResults");
    if (!RT.index) {
      list.innerHTML = "";
      setStatus("searchInfo", "البحث يحتاج نص القرآن المحمّل من الإنترنت.");
      return;
    }
    if (!q.trim()) {
      list.innerHTML = "";
      setStatus("searchInfo", "اكتب كلمة أو آية كاملة. البحث يتجاهل التشكيل ويقبل الأخطاء الإملائية البسيطة.");
      return;
    }
    const all = A.search(RT.index, q, 2000);
    const results = all.slice(0, 40);
    setStatus("searchInfo", all.length ? `عرض ${toAr(results.length)} من ${toAr(all.length)} نتيجة.` : "لا توجد نتائج. جرّب كلمة أقصر أو بدون تشكيل.");
    list.innerHTML = results.map((r) => `
      <li class="result">
        <div class="ref">${esc(surahName(r.surah))} · آية ${toAr(r.ayah)}</div>
        <div class="txt">${esc(r.text)}</div>
        <div class="chips">
          <button data-act="pick" data-s="${r.surah}" data-a="${r.ayah}">اختيار</button>
          <button data-act="add" data-s="${r.surah}" data-a="${r.ayah}">إضافة للنطاق</button>
        </div>
      </li>`).join("");
  }

  function renderVerseTable() {
    const body = $("verseBody");
    const vs = rangeVerses();
    if (!vs.length) {
      body.innerHTML = `<tr><td colspan="4" class="empty">اختر سورة ونطاقاً من الآيات.</td></tr>`;
      return;
    }
    body.innerHTML = vs.map((v) => `
      <tr data-n="${v.number}" class="${RT.activeNum === v.number ? "active" : ""}">
        <td>${toAr(v.number)}</td>
        <td class="txt">${esc(v.text)}</td>
        <td><input type="number" step="0.01" min="0" class="startIn" data-n="${v.number}" value="${isNum(S.starts[v.number]) ? S.starts[v.number] : ""}"></td>
        <td><button class="seekRow" data-n="${v.number}" title="تشغيل من هذه الآية">▶</button></td>
      </tr>`).join("");
  }

  function highlightActive(num) {
    if (num === RT.activeNum) return;
    RT.activeNum = num;
    for (const tr of $("verseBody").querySelectorAll("tr[data-n]")) {
      tr.classList.toggle("active", Number(tr.dataset.n) === num);
    }
  }

  function renderSelection() {
    const s = surahData();
    const info = selectionInfo();
    const warn = [];
    if (!s) warn.push("نص القرآن ما تحمّل بعد.");
    if (info.n > MAX_VERSES) warn.push(`الحد الأقصى ${toAr(MAX_VERSES)} آية.`);
    if (info.exact && info.seconds > MAX_SECONDS) warn.push(`المدة (${fmt(info.seconds)}) تتجاوز الحد الأقصى 05:00.`);
    if (!info.exact && info.seconds > MAX_SECONDS) warn.push("التقدير يتجاوز 05:00. المدة الفعلية تظهر بعد التوقيت.");
    if (info.n && info.timed < info.n) warn.push(`${toAr(info.n - info.timed)} آية بدون توقيت، لن تظهر في المقطع.`);
    setStatus(
      "selectionInfo",
      info.n
        ? `عدد الآيات: ${toAr(info.n)} · المدة: ${info.exact ? fmt(info.seconds) : "≈ " + fmt(info.seconds) + " (تقدير)"} · الموقّت: ${toAr(info.timed)} من ${toAr(info.n)}`
        : ""
    );
    $("selectionWarn").hidden = !warn.length;
    $("selectionWarn").textContent = warn.join(" ");
    $("audioWarning").hidden = !RT.audioDirect;
    $("audioWarning").textContent = RT.audioDirect
      ? "السيرفر منع تحميل الصوت داخل الصفحة. المعاينة تعمل، لكن التصدير يحتاج رفع ملف الصوت يدوياً."
      : "";
    const timingCount = Object.keys(S.starts).length;
    setStatus("markInfo", timingCount ? `التوقيت: ${toAr(timingCount)} آية (${S.timingSource === "mp3quran" ? "من MP3Quran" : "يدوي"}).` : "لا يوجد توقيت بعد.");
  }

  function renderReaders() {
    const qRaw = $("readerQ").value.trim().toLowerCase();
    const qNorm = A.normalize(qRaw);
    const sel = $("readerSel");
    const list = RT.readers.filter((r) => {
      const name = String(r.name || "");
      return !qRaw || name.toLowerCase().includes(qRaw) || (qNorm && A.normalize(name).includes(qNorm));
    });
    sel.innerHTML = `<option value="">— اختر القارئ —</option>` + list.map((r) =>
      `<option value="${esc(String(r.id))}">${esc(r.name)}${r.rewaya ? " — " + esc(r.rewaya) : ""}</option>`).join("");
    if (S.readerId && list.some((r) => String(r.id) === S.readerId)) sel.value = S.readerId;
    const current = RT.readers.find((r) => String(r.id) === sel.value);
    $("readerInfo").textContent = current
      ? `${current.name}${current.rewaya ? " · الرواية: " + current.rewaya : ""} · متوفر ${toAr(RT.readers.length)} قارئ بتوقيت الآيات.`
      : RT.readers.length ? `متوفر ${toAr(RT.readers.length)} قارئ بتوقيت الآيات. ابحث بالاسم.` : "";
  }

  // ---------- الخلفيات ----------
  function renderBgList() {
    const q = $("bgQ").value.trim().toLowerCase();
    const type = $("bgType").value;
    const ul = $("bgList");
    const items = S.bg.items.filter((i) => (type === "all" || i.type === type) && (!q || i.name.toLowerCase().includes(q)));
    if (!S.bg.items.length) {
      ul.innerHTML = `<li class="empty">ما في خلفيات بعد. ارفع صور أو فيديوهات، أو أضف لوناً ثابتاً.</li>`;
      return;
    }
    if (!items.length) {
      ul.innerHTML = `<li class="empty">لا توجد خلفيات تطابق البحث.</li>`;
      return;
    }
    ul.innerHTML = items.map((i) => {
      const rt = RT.bgRuntime.get(i.id);
      let thumb = `<span class="thumb" style="background:${esc(i.color || "#333")}"></span>`;
      if (i.type === "image" && rt) thumb = `<img class="thumb" src="${esc(rt.url)}" alt="">`;
      if (i.type === "video") thumb = `<span class="thumb video">▶</span>`;
      const missing = i.type !== "solid" && !rt ? `<em class="missing">غير متوفر بعد إعادة التحميل</em>` : "";
      return `<li data-id="${i.id}">
        ${thumb}
        <span class="name">${esc(i.name)} ${missing}</span>
        <button data-act="fav" class="${isFav(i) ? "on" : ""}" title="مفضلة">★</button>
        <button data-act="del" title="حذف">✕</button>
      </li>`;
    }).join("");
  }

  function createBgRuntime(meta, blob) {
    const url = URL.createObjectURL(blob);
    let el;
    if (meta.type === "video") {
      el = document.createElement("video");
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = "auto";
      el.src = url;
    } else {
      el = new Image();
      el.src = url;
    }
    RT.bgRuntime.set(meta.id, { el, url, blob, type: meta.type });
  }

  function removeBg(id) {
    const rt = RT.bgRuntime.get(id);
    if (rt) {
      if (rt.el.pause) rt.el.pause();
      URL.revokeObjectURL(rt.url);
      RT.bgRuntime.delete(id);
    }
    S.bg.items = S.bg.items.filter((i) => i.id !== id);
  }

  function clearBgRuntime() {
    for (const id of [...RT.bgRuntime.keys()]) removeBg(id);
  }

  // ---------- تحديث الواجهة بعد أي تغيير ----------
  function syncInputs() {
    for (const el of document.querySelectorAll("[data-bind]")) {
      const v = getPath(S, el.dataset.bind);
      if (el.type === "checkbox") el.checked = !!v;
      else if (el !== document.activeElement) el.value = v == null ? "" : String(v);
    }
    $("offsetLabel").textContent = `${S.offsetMs > 0 ? "+" : ""}${S.offsetMs} ms`;
    for (const b of document.querySelectorAll("[data-offset]")) {
      b.classList.toggle("active", Number(b.dataset.offset) === S.offsetMs);
    }
    $("customDims").hidden = S.design.aspect !== "custom";
    $("customYRow").hidden = S.design.textPos !== "custom";
    $("transOpts").classList.toggle("muted", !S.trans.on);
    $("tafsirOpts").classList.toggle("muted", !S.tafsir.on);
    const [w, h] = dims();
    $("dimsInfo").textContent = `مقاس الفيديو: ${toAr(w)} × ${toAr(h)} بكسل${S.lightMode ? " (وضع خفيف)" : ""}.`;
    $("res4kWarn").hidden = Math.max(w, h) < 2880;
    $("transNote").textContent = S.trans.on ? "ترجمة معاني، وليست نص القرآن الأصلي." : "";
    $("tafsirNote").textContent = S.tafsir.on ? "التفسير الميسر، ويتغيّر مع الآية الظاهرة." : "";
    $("fadeLabel").textContent = `${toAr(S.design.fadeMs)} ms`;
  }

  function renderAll() {
    syncInputs();
    renderSelection();
    renderVerseTable();
    renderSearch();
    renderReaders();
    renderBgList();
    if (S.step === 3) renderChecklist();
  }

  function onChange(path = "") {
    normalizeRange();
    if (path === "volume") applyVolume();
    if (["surah", "trans.on", "trans.edition", "tafsir.on", "tafsir.edition", "tafsir.family"].includes(path)) refreshEditions();
    RT.version++;
    renderAll();
    persistSoon();
  }

  function onSurahChanged() {
    S.starts = {};
    S.timingSource = "";
    S.from = 1;
    const s = surahData();
    S.to = s ? Math.min(s.count, 7) : 7;
    const name = surahName();
    if (!S.title.trim() || S.title === RT.lastAutoTitle) {
      S.title = name;
      RT.lastAutoTitle = name;
    }
    RT.activeNum = null;
    RT.tafsirKey = "";
    RT.transKey = "";
  }

  // ---------- المعاينة والتشغيل ----------
  function updatePlayButton() {
    $("playBtn").textContent = audio.paused ? "▶ تشغيل" : "❚❚ إيقاف";
  }

  function updateTransport(t, dur) {
    $("timeInfo").textContent = `${fmt(t)} / ${fmt(dur)}`;
    const seek = $("seek");
    seek.max = String(dur || 0);
    if (!RT.seeking) seek.value = String(Math.min(t, dur || 0));
  }

  function syncVideos(sc, t) {
    const idx = R.bgIndex(sc.bg, t);
    const playing = !audio.paused && !audio.ended;
    const changed = idx !== RT.lastBgIdx;
    RT.lastBgIdx = idx;
    sc.bg.items.forEach((item, i) => {
      if (item.type !== "video" || !item.el) return;
      if (i === idx && playing) {
        if (changed) item.el.currentTime = 0;
        if (item.el.paused) item.el.play().catch(() => {});
      } else if (!item.el.paused) {
        item.el.pause();
      }
    });
  }

  function frame() {
    requestAnimationFrame(frame);
    try {
      const [w, h] = dims();
      if (canvas.width !== w || canvas.height !== h) resizeCanvas(w, h);
      const sc = buildScene();
      const t = audio.currentTime || 0;
      syncVideos(sc, t);
      R.draw(ctx, sc, t);
      updateTransport(t, sc.duration);
      const seg = R.activeSegment(sc.segments, t);
      highlightActive(seg ? seg.number : null);
      if (RT.exporting) updateExportProgress(t);
    } catch (err) {
      console.error(err);
    }
  }

  function resizeCanvas(w, h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.aspectRatio = `${w} / ${h}`;
    RT.version++;
  }

  // ---------- جلب القرآن والقراء والصوت ----------
  async function loadQuranData() {
    setStatus("quranStatus", "جاري تحميل نص القرآن (مرة واحدة، ثم يُحفظ على جهازك)...");
    $("retryQuranBtn").hidden = true;
    try {
      RT.quran = await SV.loadQuran();
      RT.index = A.buildIndex(RT.quran.surahs.flatMap((s) => s.ayahs.map((a) => ({ surah: s.number, ayah: a.number, text: a.text }))));
      setStatus("quranStatus", "");
      $("pasteBox").hidden = true;
      renderSurahOptions();
      if (!S.title.trim()) S.title = surahName();
      normalizeRange();
      onChange("quran");
    } catch (err) {
      setStatus("quranStatus", `تعذر تحميل نص القرآن من الإنترنت (${err.message}). تحقق من الاتصال وأعد المحاولة، أو الصق نص الآيات يدوياً أدناه.`, "error");
      $("retryQuranBtn").hidden = false;
      $("pasteBox").hidden = false;
    }
  }

  function applyPastedText() {
    const lines = $("pasteInput").value.split("\n").map((t) => t.trim()).filter(Boolean);
    if (!lines.length) return toast("الصق نص الآيات أولاً، سطر لكل آية.", "error");
    RT.custom = {
      number: 0,
      name: "نص مُدخل",
      count: lines.length,
      ayahs: lines.map((text, i) => ({ number: i + 1, text })),
    };
    S.surah = 0;
    S.from = 1;
    S.to = lines.length;
    S.starts = {};
    S.timingSource = "";
    renderSurahOptions();
    syncInputs();
    onChange("surah");
    toast("تم إدخال النص. تحقق من مطابقته للمصحف قبل النشر.", "info");
  }

  async function loadReaders() {
    setStatus("mp3Status", "جاري تحميل قائمة القراء...");
    try {
      RT.readers = await SV.loadReaders();
      setStatus("mp3Status", "");
      renderReaders();
    } catch (err) {
      setStatus("mp3Status", `تعذر تحميل قائمة القراء من MP3Quran (${err.message}).`, "error");
    }
  }

  async function fetchFromReciter() {
    const reader = RT.readers.find((r) => String(r.id) === $("readerSel").value);
    if (!reader) return setStatus("mp3Status", "اختر القارئ أولاً.", "error");
    if (!reader.folder_url) return setStatus("mp3Status", "هالقارئ ما عنده رابط صوت متوفر.", "error");
    if (S.surah === 0) return setStatus("mp3Status", "التوقيت متوفر للسور الرسمية فقط.", "error");
    const surah = S.surah;
    try {
      setStatus("mp3Status", "جاري جلب التوقيت...");
      const list = await SV.loadTiming(surah, reader.id);
      if (!list.length) throw new Error("ما فيه توقيت لهالسورة عند هالقارئ.");
      S.readerId = String(reader.id);
      S.readerName = reader.name || "";
      if (!S.reciterName.trim()) S.reciterName = reader.name || "";
      setStatus("mp3Status", "جاري تحميل الصوت...");
      const url = SV.audioUrlFor(reader, surah);
      const { blob, direct, reason } = await SV.fetchAudioBlob(url, STORE.prefs.get().cacheAudio);
      if (surah !== S.surah) return; // المستخدم غيّر السورة أثناء الجلب
      const name = `${reader.name} — ${surah}`;
      if (blob) setNewAudio(URL.createObjectURL(blob), blob, "remote", name, false);
      else setNewAudio(url, null, "remote", name, true);
      RT.pendingTiming = list; // نطبّقه عند تحميل بيانات الصوت (loadedmetadata)
      STORE.history.add("reciter", reader.name || "");
      if (direct) toast(`الصوت من الموقع مباشرة${reason ? " (" + reason + ")" : ""}.`, "info");
      onChange("audio");
    } catch (err) {
      RT.pendingTiming = null;
      setStatus("mp3Status", `تعذر الجلب من MP3Quran (${err.message}). جرّب لاحقاً أو ارفع الصوت يدوياً.`, "error");
    }
  }

  // ---------- التحديد: الآيات والتوقيت اليدوي ----------
  function selectVerse(s, a, add) {
    if (s !== S.surah) {
      S.surah = s;
      onSurahChanged();
      S.from = a;
      S.to = a;
    } else if (add) {
      S.from = Math.min(S.from, a);
      S.to = Math.max(S.to, a);
    } else {
      S.from = a;
      S.to = a;
    }
    onChange("surah");
  }

  function markNext() {
    if (!audioReady()) return toast("ارفع الصوت أو اجلب صوت القارئ أولاً.", "error");
    const vs = rangeVerses();
    const next = vs.find((v) => !isNum(S.starts[v.number]));
    if (!next) return toast("تم توقيت كل الآيات المختارة.", "info");
    S.starts[next.number] = round2(audio.currentTime);
    S.timingSource = S.timingSource || "manual";
    onChange("timing");
  }

  function undoMark() {
    const vs = rangeVerses().slice().reverse();
    const last = vs.find((v) => isNum(S.starts[v.number]));
    if (!last) return;
    delete S.starts[last.number];
    onChange("timing");
  }

  function clearRangeTiming() {
    for (const v of rangeVerses()) delete S.starts[v.number];
    onChange("timing");
  }

  function playFrom(n) {
    if (!audioReady() || !isNum(S.starts[n])) return;
    ensureAudioGraph();
    audio.currentTime = Math.max(0, S.starts[n] + S.offsetMs / 1000);
    audio.play().catch(() => {});
  }

  // ---------- التصدير ----------
  function pickMime() {
    if (!window.MediaRecorder) return null;
    const options = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    return options.find((m) => MediaRecorder.isTypeSupported(m)) || null;
  }

  function bitrateFor(w, h) {
    const px = w * h;
    if (px >= 8e6) return 16e6; // 4K
    return px >= 2.5e6 ? 10e6 : px >= 1e6 ? 6e6 : 3.5e6;
  }

  function validateExport() {
    const p = [];
    const vs = rangeVerses();
    if (!vs.length) p.push("اختر سورة ونطاق آيات أولاً.");
    if (vs.length > MAX_VERSES) p.push(`الحد الأقصى ${toAr(MAX_VERSES)} آية.`);
    if (!audioReady()) p.push("ارفع ملف الصوت أو اجلب صوت القارئ أولاً.");
    else if (RT.audioDirect) p.push("الصوت من موقع خارجي ولا يدخل التسجيل. ارفع ملف الصوت يدوياً ثم صدّر.");
    if (!buildSegments().length) p.push("وقّت آية واحدة على الأقل من النطاق.");
    const dur = audioDuration();
    if (dur && Object.values(S.starts).some((v) => isNum(v) && v > dur + 0.5)) {
      p.push("توقيت بعض الآيات أكبر من مدة الصوت. تحقق من التوقيت أو أعد جلبه.");
    }
    const info = selectionInfo();
    if (info.exact && info.seconds > MAX_SECONDS) p.push(`مدة المقطع ${fmt(info.seconds)} تتجاوز الحد الأقصى 05:00.`);
    return p;
  }

  function renderChecklist() {
    const info = selectionInfo();
    const [w, h] = dims();
    const rows = [
      [rangeVerses().length > 0, `الآيات: ${toAr(info.n)} آية من ${surahName() || "—"}`],
      [audioReady() && !RT.audioDirect, audioReady() ? (RT.audioDirect ? "الصوت خارجي (يحتاج رفع يدوي للتصدير)" : `الصوت جاهز: ${S.audioName || ""}`) : "الصوت: لم يُختر بعد"],
      [info.timed > 0 && info.timed === info.n, `التوقيت: ${toAr(info.timed)} من ${toAr(info.n)} آية`],
      [info.exact && info.seconds <= MAX_SECONDS, `المدة: ${info.exact ? fmt(info.seconds) : "تقديرية"} (الحد 05:00)`],
      [!S.tafsir.on || RT.tafsirKey === tafsirKeyNow(), S.tafsir.on ? "التفسير: مفعّل" : "التفسير: مخفي"],
      [!S.trans.on || RT.transKey === transKeyNow(), S.trans.on ? `الترجمة: ${translationInfo().label}` : "الترجمة: مخفية"],
      [true, `الدقة: ${toAr(w)} × ${toAr(h)}`],
    ];
    $("checklist").innerHTML = rows.map(([ok, text]) =>
      `<li class="${ok ? "ok" : "bad"}"><span>${ok ? "✓" : "!"}</span> ${esc(text)}</li>`).join("");
    const problems = validateExport();
    $("exportBtn").disabled = RT.exporting || problems.length > 0;
    setStatus("exportNote", problems.length ? problems[0] : "جاهز للتصدير.", problems.length ? "warn" : "ok");
  }

  function setStage(text, kind = "") {
    setStatus("stageText", text, kind);
  }

  function setExportUi(on) {
    $("exportBtn").disabled = on;
    $("cancelBtn").hidden = !on;
    $("retryBtn").hidden = on || !RT.lastError;
  }

  function updateExportProgress(t) {
    const total = Math.max(0.1, RT.exportEnd - RT.exportStart);
    const done = clamp((t - RT.exportStart) / total, 0, 1);
    $("progressBar").style.width = `${(done * 100).toFixed(1)}%`;
    const remaining = Math.max(0, RT.exportEnd - t);
    setStatus("remainingText", `المتبقي تقريباً: ${fmt(remaining)} · ${toAr(Math.round(done * 100))}%`);
    if (t >= RT.exportEnd - 0.05 || audio.ended) stopRecording();
  }

  function stopRecording() {
    audio.pause();
    if (RT.recorder && RT.recorder.state !== "inactive") {
      try { RT.recorder.stop(); } catch (_) { /* مغلق أصلاً */ }
    }
  }

  async function startExport() {
    if (RT.exporting) return;
    RT.lastError = null;
    RT.cancelled = false;
    $("retryBtn").hidden = true;
    $("resultBox").hidden = true;
    $("progressBar").style.width = "0%";
    const problems = validateExport();
    if (problems.length) return setStage(problems[0], "error");
    const mime = pickMime();
    if (!mime) return abortExport(new Error("متصفحك ما يدعم تسجيل الفيديو. جرّب Chrome أو Edge أو Firefox."));

    try {
      setStage("تحميل التفسير والترجمة...");
      await ensureEditions(true);
      setStage("تجهيز الصوت...");
      await waitAudioReady(15000);
      if (!ensureAudioGraph()) throw new Error("لا يمكن تسجيل صوت من موقع خارجي. ارفع ملف الصوت يدوياً.");
      await audioCtx.resume();

      const segs = buildSegments();
      if (!segs.length) throw new Error("لا توجد آيات موقّتة في النطاق.");
      const [w, h] = dims();
      if (canvas.width !== w || canvas.height !== h) resizeCanvas(w, h);

      RT.exportStart = Math.max(0, segs[0].start - 0.3);
      RT.exportEnd = Math.min(segs[segs.length - 1].end + 0.6, audioDuration() || Infinity);
      const videoTracks = canvas.captureStream(30).getVideoTracks();
      RT.exportStream = new MediaStream([...videoTracks, ...mediaDest.stream.getAudioTracks()]);
      RT.exportMime = mime;
      RT.chunks = [];

      const rec = new MediaRecorder(RT.exportStream, {
        mimeType: mime,
        videoBitsPerSecond: bitrateFor(w, h),
        audioBitsPerSecond: 192000,
      });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) RT.chunks.push(e.data); };
      rec.onerror = (e) => abortExport(new Error((e.error && e.error.message) || "خطأ في المسجّل."));
      rec.onstop = () => finishExport();
      RT.recorder = rec;
      RT.exporting = true;
      setExportUi(true);
      setKeepScreen(true);

      audio.pause();
      await seekTo(RT.exportStart);
      rec.start(1000);
      await audio.play();
      setStage("جاري التسجيل. أبقِ الصفحة مفتوحة وفي المقدمة.");
    } catch (err) {
      abortExport(err);
    }
  }

  function cancelExport() {
    if (!RT.exporting) return;
    RT.cancelled = true;
    stopRecording();
    setStage("تم إلغاء التصدير.");
  }

  function finishExport() {
    RT.exporting = false;
    setKeepScreen(false);
    if (RT.exportStream) RT.exportStream.getTracks().forEach((t) => t.stop());
    setExportUi(false);
    if (RT.cancelled) {
      RT.chunks = [];
      $("progressBar").style.width = "0%";
      setStatus("remainingText", "");
      return;
    }
    const type = (RT.exportMime || "").split(";")[0] || "video/webm";
    const blob = new Blob(RT.chunks, { type });
    RT.chunks = [];
    if (blob.size < 2000) return abortExport(new Error("الملف الناتج فارغ أو قصير جداً. أعد المحاولة."));
    const ext = type === "video/mp4" ? "mp4" : "webm";
    const name = `inaba-surah-${S.surah}-${S.from}-${S.to}.${ext}`;
    RT.lastBlob = blob;
    $("progressBar").style.width = "100%";
    setStatus("remainingText", "");
    showResult(blob, name);
    setStage("جاهز: الفيديو مُصدَّر.", "ok");
    STORE.history.add("export", name);
    if (nativeBridge) saveNative(blob, name);
  }

  function showResult(blob, name) {
    if (RT.resultUrl) URL.revokeObjectURL(RT.resultUrl);
    RT.resultUrl = URL.createObjectURL(blob);
    const v = $("resultVideo");
    v.src = RT.resultUrl;
    const link = $("downloadLink");
    link.href = RT.resultUrl;
    link.download = name;
    link.textContent = `تحميل الفيديو (${name.endsWith(".mp4") ? "MP4" : "WebM"})`;
    $("shareBtn").hidden = !(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] }));
    $("resultBox").hidden = false;
    RT.lastName = name;
  }

  async function shareResult() {
    if (!RT.lastBlob) return;
    try {
      const file = new File([RT.lastBlob], RT.lastName, { type: RT.lastBlob.type });
      await navigator.share({ files: [file], title: "مقطع قرآني" });
    } catch (err) {
      if (err.name !== "AbortError") toast("تعذرت المشاركة. استخدم زر التحميل.", "error");
    }
  }

  function abortExport(err) {
    RT.lastError = err;
    if (RT.recorder && RT.recorder.state !== "inactive") {
      RT.cancelled = true;
      try { RT.recorder.stop(); } catch (_) { /* لا شيء */ }
    }
    RT.exporting = false;
    RT.chunks = [];
    audio.pause();
    setKeepScreen(false);
    if (RT.exportStream) RT.exportStream.getTracks().forEach((t) => t.stop());
    setExportUi(false);
    $("retryBtn").hidden = false;
    setStage(`تعذّر التصدير: ${err.message || "خطأ غير معروف"}`, "error");
    renderChecklist();
  }

  // حفظ على جهاز أندرويد (جسر التطبيق)
  function setKeepScreen(on) {
    try { if (nativeBridge) nativeBridge.setKeepScreenOn(on); } catch (_) { /* تجاهل */ }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function saveToDevice(blob, fileName) {
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!nativeBridge.beginSave(safe, blob.type)) throw new Error("تعذر بدء الحفظ");
    try {
      for (let off = 0; off < blob.size; off += SAVE_CHUNK) {
        const part = await blobToBase64(blob.slice(off, off + SAVE_CHUNK));
        if (!nativeBridge.appendChunk(part)) throw new Error("تعذر كتابة جزء من الملف");
      }
    } catch (err) {
      nativeBridge.cancelSave();
      throw err;
    }
    const result = String(nativeBridge.endSave());
    if (result.startsWith("ERROR")) throw new Error(result);
    return result;
  }

  async function saveNative(blob, name) {
    setStage("جاري حفظ الفيديو في جهازك...");
    try {
      const where = await saveToDevice(blob, name);
      setStage(`تم حفظ الفيديو في: ${where}`, "ok");
    } catch (err) {
      setStage("تعذر حفظ الفيديو في الجهاز. استخدم زر التحميل أو أعد المحاولة.", "error");
    }
  }

  // ---------- المسودات ----------
  function serializeState() {
    return JSON.parse(JSON.stringify(S));
  }

  function collectMedia() {
    const media = [];
    for (const meta of S.bg.items) {
      if (meta.type === "solid" || meta.libId) continue; // خلفيات المكتبة تُستعاد من manifest
      const rt = RT.bgRuntime.get(meta.id);
      if (rt && rt.blob) media.push({ refId: `bg:${meta.id}`, role: "bg", name: meta.name, type: rt.blob.type, blob: rt.blob });
    }
    if (RT.audioBlob) media.push({ refId: "audio", role: "audio", name: S.audioName, type: RT.audioBlob.type, blob: RT.audioBlob });
    return media;
  }

  // إذا فتحت مسودة وما كتبت اسماً جديداً، نحدّثها. إذا كتبت اسماً مختلفاً، نحفظها كمسودة جديدة.
  async function saveDraft() {
    const typed = $("draftName").value.trim();
    const now = Date.now();
    let current = null;
    if (RT.currentDraftId) {
      try { current = (await DB.getProject(RT.currentDraftId)).project; } catch (_) { current = null; }
    }
    const updating = !!current && (!typed || typed === current.name);
    const id = updating ? current.id : uid();
    const createdAt = updating ? current.createdAt : now;
    const name = typed || (updating ? current.name : `${surahName() || "مسودة"} ${toAr(S.from)}-${toAr(S.to)}`);
    try {
      setStatus("draftStatus", "جاري الحفظ...");
      await DB.saveProject(
        { id, name, createdAt, updatedAt: now, summary: { surah: S.surah, from: S.from, to: S.to, reciter: S.readerName || S.audioName }, state: serializeState() },
        collectMedia()
      );
      RT.currentDraftId = id;
      $("draftName").value = "";
      setStatus("draftStatus", `${updating ? "تم تحديث" : "تم حفظ"} المسودة: ${name}`, "ok");
      STORE.history.add("draft", name);
      renderDrafts();
    } catch (err) {
      setStatus("draftStatus", err.message, "error");
    }
  }

  async function openDraft(id) {
    try {
      const { project, media } = await DB.getProject(id);
      stopPlayback();
      clearBgRuntime();
      revokeAudioUrl();
      S = mergeDeep(defaults(), project.state);
      RT.currentDraftId = id;
      RT.tafsirKey = "";
      RT.transKey = "";
      const byRef = new Map(media.map((m) => [m.refId, m]));
      for (const meta of S.bg.items) {
        if (meta.type === "solid") continue;
        if (meta.libId) {
          await ensureLibRuntime(meta).catch(() => {});
          continue;
        }
        const m = byRef.get(`bg:${meta.id}`);
        if (m && m.blob) createBgRuntime(meta, m.blob);
      }
      S.bg.items = S.bg.items.filter((i) => i.type === "solid" || RT.bgRuntime.has(i.id));
      // خط مرفوع في المسودة لكن ما هو متوفر على هذا الجهاز: نرجع للافتراضي بدل ما يظهر خط ناقص
      if (S.design.fontFamily === USER_FONT && !RT.userFace) {
        S.design.fontFamily = "Amiri Quran";
        toast("هذه المسودة تستخدم خطاً مرفوعاً غير موجود على هذا الجهاز. استُخدم Amiri Quran.", "info");
      }
      if (S.tafsir.family === USER_FONT && !RT.userFace) S.tafsir.family = "Noto Naskh Arabic";
      const audioMedia = byRef.get("audio");
      if (audioMedia && audioMedia.blob) {
        attachAudio(URL.createObjectURL(audioMedia.blob), audioMedia.blob, S.audioKind === "file" ? "file" : "remote", S.audioName, false);
      } else {
        attachAudio("", null, "none", "", false);
        audio.removeAttribute("src");
        audio.load();
      }
      RT.pendingTiming = null;
      RT.lastBgIdx = -2;
      await loadQuranIfNeeded();
      $("draftName").value = project.name;
      showView("create");
      goStep(1);
      onChange("open");
      toast(`تم فتح المسودة: ${project.name}`, "info");
      STORE.history.add("open", project.name);
    } catch (err) {
      toast(`تعذر فتح المسودة: ${err.message}`, "error");
    }
  }

  async function loadQuranIfNeeded() {
    if (!RT.quran) await loadQuranData();
  }

  async function renderDrafts() {
    const list = $("draftList");
    try {
      const rows = await DB.listProjects();
      $("draftCount").textContent = `${toAr(rows.length)} من ${toAr(DB.MAX_DRAFTS)} مسودة`;
      if (!rows.length) {
        list.innerHTML = `<li class="empty">ما في مسودات محفوظة بعد.</li>`;
        return;
      }
      list.innerHTML = rows.map((p) => {
        const sm = p.summary || {};
        const date = new Date(p.updatedAt).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
        return `<li data-id="${p.id}">
          <div class="draft-main">
            <strong class="draft-name">${esc(p.name)}</strong>
            <span class="hint">${esc(sm.reciter || "")} · الآيات ${toAr(sm.from || 1)}–${toAr(sm.to || 1)} · آخر تعديل ${esc(date)}</span>
          </div>
          <div class="chips">
            <button data-act="open" class="primary">متابعة التحرير</button>
            <button data-act="rename">إعادة تسمية</button>
            <button data-act="dup">نسخ</button>
            <button data-act="del">حذف</button>
          </div>
        </li>`;
      }).join("");
    } catch (err) {
      list.innerHTML = `<li class="empty">تعذر قراءة المسودات: ${esc(err.message)}</li>`;
    }
  }

  async function handleDraftAction(act, li) {
    const id = li.dataset.id;
    try {
      if (act === "open") return openDraft(id);
      if (act === "del") {
        if (li.dataset.armed !== "1") {
          li.dataset.armed = "1";
          li.querySelector('[data-act="del"]').textContent = "تأكيد الحذف";
          setTimeout(() => { if (li.isConnected) renderDrafts(); }, 4000);
          return;
        }
        const label = li.querySelector(".draft-name") ? li.querySelector(".draft-name").textContent : "";
        await DB.deleteProject(id);
        STORE.history.add("delete", label);
        if (RT.currentDraftId === id) RT.currentDraftId = null;
        toast("تم حذف المسودة.", "info");
        return renderDrafts();
      }
      if (act === "dup") {
        const { project, media } = await DB.getProject(id);
        const copyId = uid();
        await DB.saveProject(
          { ...project, id: copyId, name: `${project.name} (نسخة)`, createdAt: Date.now(), updatedAt: Date.now() },
          media.map((m) => ({ refId: m.refId, role: m.role, name: m.name, type: m.type, blob: m.blob }))
        );
        toast("تم نسخ المسودة.", "info");
        return renderDrafts();
      }
      if (act === "rename") {
        const row = li.querySelector(".draft-main");
        const current = row.querySelector(".draft-name").textContent;
        row.innerHTML = `<div class="row"><input class="renameIn" value="${esc(current)}"><button data-act="rename-save" class="primary">حفظ</button></div>`;
        row.querySelector(".renameIn").focus();
      }
      if (act === "rename-save") {
        const val = li.querySelector(".renameIn").value.trim();
        if (!val) return toast("الاسم ما يصير فارغ.", "error");
        await DB.renameProject(id, val);
        return renderDrafts();
      }
    } catch (err) {
      toast(`تعذّرت العملية: ${err.message}`, "error");
    }
  }

  // ---------- الإعدادات المحفوظة بين إعادة تحميل الصفحة ----------
  let persistTimer = null;
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        localStorage.setItem(EDITOR_KEY, JSON.stringify(S));
      } catch (_) { /* التخزين ممتلئ أو معطّل */ }
    }, 400);
  }

  // يرجّع true إذا فيه ملفات كانت مرفوعة وما تقدر تتسترجع بعد إعادة التحميل
  function restoreEditor() {
    try {
      const saved = JSON.parse(localStorage.getItem(EDITOR_KEY) || "null");
      if (saved) S = mergeDeep(defaults(), saved);
    } catch (_) { /* إعدادات تالفة: نبدأ من الافتراضي */ }
    // خلفيات المكتبة تُعاد من manifest بعد التحميل، فما نعتبرها ملفات مفقودة
    const hadFiles = S.bg.items.some((i) => i.type !== "solid" && !i.libId) || S.audioKind === "file";
    S.bg.items = S.bg.items.filter((i) => i.type === "solid" || i.libId);
    S.audioKind = "none";
    S.audioName = "";
    S.step = clamp(S.step || 1, 1, 3);
    return hadFiles;
  }

  // ---------- المظهر والتنقل بين الصفحات ----------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $("themeBtn").textContent = theme === "light" ? "☾ داكن" : "☀ فاتح";
    STORE.prefs.set({ theme });
  }

  function showView(name) {
    for (const v of document.querySelectorAll("[data-view-panel]")) v.hidden = v.dataset.viewPanel !== name;
    for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("active", b.dataset.view === name);
    if (name === "home") renderHome();
    if (name === "drafts") renderDrafts();
    if (name === "library") renderLibrary();
    if (name === "reciters") renderReadersPage();
    if (name === "favorites") renderFavorites();
    if (name === "settings") renderSettings();
  }

  // ---------- ربط الأحداث ----------
  function readValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.dataset.kind === "int") return Math.round(Number(el.value)) || 0;
    return el.value;
  }

  function bindControls() {
    for (const el of document.querySelectorAll("[data-bind]")) {
      const path = el.dataset.bind;
      const evt = el.tagName === "SELECT" || el.type === "checkbox" || el.type === "color" ? "change" : "input";
      el.addEventListener(evt, () => {
        const value = readValue(el);
        const prev = getPath(S, path);
        setPath(S, path, value);
        if (path === "surah" && value !== prev) onSurahChanged();
        if (path === "surah") normalizeRange();
        onChange(path);
      });
    }

    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
    document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.step))));
    document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.go))));
    $("themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

    // البحث
    let searchTimer = null;
    $("searchQ").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderSearch, 120);
    });
    $("searchResults").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      selectVerse(Number(btn.dataset.s), Number(btn.dataset.a), btn.dataset.act === "add");
    });

    // الآيات
    $("addPrevBtn").addEventListener("click", () => { S.from = Math.max(1, S.from - 1); onChange("from"); });
    $("addNextBtn").addEventListener("click", () => { const s = surahData(); S.to = Math.min(s ? s.count : S.to, S.to + 1); onChange("to"); });
    $("removeLastBtn").addEventListener("click", () => {
      if (S.to <= S.from) return toast("لازم تبقى آية واحدة على الأقل.", "error");
      S.to -= 1;
      onChange("to");
    });
    $("fullSurahBtn").addEventListener("click", () => { const s = surahData(); if (s) { S.from = 1; S.to = s.count; onChange("to"); } });
    $("applyPasteBtn").addEventListener("click", applyPastedText);
    $("retryQuranBtn").addEventListener("click", loadQuranData);

    $("verseBody").addEventListener("change", (e) => {
      const input = e.target.closest(".startIn");
      if (!input) return;
      const n = Number(input.dataset.n);
      const raw = input.value.trim();
      if (raw === "") delete S.starts[n];
      else S.starts[n] = Math.max(0, round2(Number(raw)));
      S.timingSource = "manual";
      onChange("timing");
    });
    $("verseBody").addEventListener("click", (e) => {
      const btn = e.target.closest(".seekRow");
      if (btn) playFrom(Number(btn.dataset.n));
    });
    $("markBtn").addEventListener("click", markNext);
    $("undoBtn").addEventListener("click", undoMark);
    $("clearTimingBtn").addEventListener("click", clearRangeTiming);

    // القارئ والصوت
    $("readerQ").addEventListener("input", renderReaders);
    $("readerSel").addEventListener("change", () => {
      const r = RT.readers.find((x) => String(x.id) === $("readerSel").value);
      if (r) $("readerInfo").textContent = `${r.name}${r.rewaya ? " · الرواية: " + r.rewaya : ""}`;
    });
    $("fetchTimingBtn").addEventListener("click", fetchFromReciter);
    $("audioFile").addEventListener("change", () => {
      const file = $("audioFile").files[0];
      if (!file) return;
      setNewAudio(URL.createObjectURL(file), file, "file", file.name, false);
      onChange("audio");
      toast("تم رفع الصوت. وقّت الآيات يدوياً أو اجلب توقيت MP3Quran.", "info");
    });

    // المعاينة
    $("playBtn").addEventListener("click", async () => {
      if (!audioReady()) return toast("ارفع الصوت أو اجلب صوت القارئ أولاً.", "error");
      ensureAudioGraph();
      try {
        if (audio.paused) await audio.play();
        else audio.pause();
      } catch (err) {
        toast(`تعذر تشغيل الصوت: ${err.message}`, "error");
      }
    });
    $("restartBtn").addEventListener("click", () => {
      const first = rangeVerses().find((v) => isNum(S.starts[v.number]));
      audio.currentTime = first ? Math.max(0, S.starts[first.number] + S.offsetMs / 1000) : 0;
    });
    $("back5Btn").addEventListener("click", () => { audio.currentTime = clamp(audio.currentTime - 5, 0, audioDuration()); });
    $("fwd5Btn").addEventListener("click", () => { audio.currentTime = clamp(audio.currentTime + 5, 0, audioDuration()); });
    const seek = $("seek");
    seek.addEventListener("pointerdown", () => { RT.seeking = true; });
    seek.addEventListener("pointerup", () => { RT.seeking = false; });
    seek.addEventListener("input", () => { audio.currentTime = Number(seek.value); });
    for (const b of document.querySelectorAll("[data-offset]")) {
      b.addEventListener("click", () => { S.offsetMs = Number(b.dataset.offset); onChange("offset"); });
    }
    audio.addEventListener("play", updatePlayButton);
    audio.addEventListener("pause", updatePlayButton);
    audio.addEventListener("ended", () => { if (RT.exporting) stopRecording(); updatePlayButton(); });
    audio.addEventListener("loadedmetadata", () => {
      if (RT.pendingTiming) {
        const list = RT.pendingTiming;
        RT.pendingTiming = null;
        applyMp3Timing(list);
      }
      onChange("audio");
    });
    audio.addEventListener("error", () => {
      if (!audio.getAttribute("src")) return;
      toast("تعذّر تحميل الصوت. تحقق من الملف أو الاتصال.", "error");
    });

    // الخطوة 2
    for (const b of document.querySelectorAll("[data-preset]")) {
      b.addEventListener("click", () => {
        Object.assign(S.design, PRESETS[b.dataset.preset] || {});
        onChange("design");
      });
    }
    $("bgFile").addEventListener("change", () => {
      for (const file of $("bgFile").files) {
        const id = uid();
        const type = file.type.startsWith("video/") ? "video" : "image";
        const meta = { id, name: file.name, type, color: "", fav: false };
        createBgRuntime(meta, file);
        S.bg.items.push(meta);
      }
      $("bgFile").value = "";
      onChange("bg");
    });
    $("addSolidBtn").addEventListener("click", () => {
      const color = $("bgColor").value;
      S.bg.items.push({ id: uid(), name: color, type: "solid", color, fav: false });
      onChange("bg");
    });
    $("shuffleBtn").addEventListener("click", () => {
      const a = S.bg.items;
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      onChange("bg");
    });
    $("bgQ").addEventListener("input", renderBgList);
    $("bgType").addEventListener("change", renderBgList);
    $("bgList").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.closest("li").dataset.id;
      if (btn.dataset.act === "del") removeBg(id);
      if (btn.dataset.act === "fav") {
        const meta = S.bg.items.find((i) => i.id === id);
        if (meta && meta.libId) STORE.favorites.toggle("bg", meta.libId);
        else if (meta) meta.fav = !meta.fav;
      }
      onChange("bg");
    });

    // الخطوة 3
    $("exportBtn").addEventListener("click", startExport);
    $("cancelBtn").addEventListener("click", cancelExport);
    $("retryBtn").addEventListener("click", startExport);
    $("shareBtn").addEventListener("click", shareResult);

    // المسودات
    $("saveDraftBtn").addEventListener("click", saveDraft);
    $("draftList").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      handleDraftAction(btn.dataset.act, btn.closest("li"));
    });
  }

  // ==================== الصفحات: الرئيسية والمكتبة والقرّاء والمفضلة والإعدادات ====================
  const isFav = (meta) => (meta.libId ? STORE.favorites.has("bg", meta.libId) : !!meta.fav);
  const mbText = (n) => `${toAr((Math.round((n / 1048576) * 10) / 10).toFixed(1))} ميغابايت`;
  const HIST_LABELS = {
    export: "تصدير فيديو", draft: "حفظ مسودة", open: "فتح مسودة", delete: "حذف مسودة",
    library: "إضافة خلفية", reciter: "جلب من قارئ", backup: "نسخة احتياطية", restore: "استيراد نسخة",
  };

  // زر بخطوتين: الضغطة الأولى تطلب التأكيد والثانية تنفّذ. يرجّع true عند التنفيذ.
  function disarm(btn) {
    btn.dataset.armed = "";
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
  function confirmTwice(btn, armText) {
    if (btn.dataset.armed === "1") {
      disarm(btn);
      return true;
    }
    btn.dataset.armed = "1";
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = armText;
    setTimeout(() => { if (btn.dataset.armed === "1") disarm(btn); }, 4000);
    return false;
  }

  // ---------- مشروع جديد ----------
  function newProject() {
    stopPlayback();
    clearBgRuntime();
    revokeAudioUrl();
    audio.removeAttribute("src");
    audio.load();
    RT.audioBlob = null;
    RT.audioDirect = false;
    const d = defaults();
    const p = STORE.prefs.get().defaults;
    d.design.aspect = p.aspect;
    d.design.res = p.res;
    d.lightMode = !!p.lightMode;
    S = d;
    RT.currentDraftId = null;
    RT.pendingTiming = null;
    RT.activeNum = null;
    RT.lastBgIdx = -2;
    RT.tafsirKey = "";
    RT.transKey = "";
    RT.tafsirMap = null;
    RT.transMap = null;
    S.title = surahName() || "";
    RT.lastAutoTitle = S.title;
    $("draftName").value = "";
    setStatus("draftStatus", "");
    onChange("new");
    goStep(1);
    showView("create");
    toast("مشروع جديد. الإعدادات الافتراضية من صفحة الإعدادات.", "info");
  }

  // ---------- الرئيسية وسجل النشاط ----------
  function historyHtml(limit) {
    const rows = STORE.history.list().slice(0, limit || undefined);
    if (!rows.length) return `<li class="empty">لا يوجد نشاط بعد.</li>`;
    return rows.map((r) => `<li><span>${esc(HIST_LABELS[r.type] || r.type)}${r.label ? ": " + esc(r.label) : ""}</span><span>${esc(new Date(r.t).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" }))}</span></li>`).join("");
  }

  function renderHistoryLists() {
    $("homeHistory").innerHTML = historyHtml(5);
    $("histList").innerHTML = historyHtml();
  }

  async function renderHome() {
    renderHistoryLists();
    try {
      const rows = (await DB.listProjects()).slice(0, 3);
      $("homeDrafts").innerHTML = rows.length
        ? rows.map((p) => `<li data-id="${esc(p.id)}"><div class="draft-main"><strong class="draft-name">${esc(p.name)}</strong></div><div class="chips"><button data-act="open" class="primary">متابعة التحرير</button></div></li>`).join("")
        : `<li class="empty">ما في مسودات بعد.</li>`;
    } catch (err) {
      $("homeDrafts").innerHTML = `<li class="empty">تعذّر قراءة المسودات: ${esc(err.message)}</li>`;
    }
  }

  // ---------- خلفيات المكتبة ----------
  const libItemById = (id) => RT.lib.items.find((i) => i.id === id) || null;

  // يحمّل ملف خلفية المكتبة ويضيفه للتشغيل. إذا كان العنصر غير موجود في المانيفست يرجّع false
  async function ensureLibRuntime(meta) {
    if (!meta.libId || RT.bgRuntime.has(meta.id)) return true;
    const item = libItemById(meta.libId);
    if (!item) return false;
    let res;
    try {
      res = await fetch(LIB.itemUrl(item));
    } catch (_) {
      throw new Error(`تعذّر تحميل "${item.title}". تحقق من الملفات أو الاتصال.`);
    }
    if (!res.ok) throw new Error(`تعذّر تحميل "${item.title}" (HTTP ${res.status}).`);
    createBgRuntime(meta, await res.blob());
    return true;
  }

  // بعد تحميل الصفحة نعيد ربط خلفيات المكتبة من manifest. إذا اختفى العنصر من المكتبة نزيله من المحرر.
  async function rehydrateLibrary() {
    if (!RT.lib.items.length) return; // المكتبة ما تحمّلت: نترك العناصر كما هي
    const removed = [];
    for (const meta of [...S.bg.items]) {
      if (!meta.libId) continue;
      try {
        const ok = await ensureLibRuntime(meta);
        if (!ok) {
          removed.push(meta.name);
          S.bg.items = S.bg.items.filter((i) => i.id !== meta.id);
        }
      } catch (err) {
        toast(err.message, "error");
      }
    }
    if (removed.length) toast(`أُزيلت ${toAr(removed.length)} خلفية لم تعد في المكتبة.`, "info");
    onChange("bg");
  }

  async function addLibraryItem(item) {
    if (S.bg.items.some((i) => i.libId === item.id)) return toast("هذه الخلفية موجودة في المحرر.", "info");
    const meta = { id: uid(), name: item.title, type: item.type, color: "", fav: false, libId: item.id };
    S.bg.items.push(meta);
    try {
      await ensureLibRuntime(meta);
      STORE.recent.push(item.id);
      STORE.history.add("library", item.title);
      toast(`أُضيفت الخلفية: ${item.title}`, "info");
    } catch (err) {
      S.bg.items = S.bg.items.filter((i) => i.id !== meta.id);
      toast(err.message, "error");
    }
    onChange("bg");
    renderLibrary();
  }

  function filteredLibrary() {
    const q = $("libQ").value.trim().toLowerCase();
    const cat = $("libCat").value;
    const type = $("libType").value;
    const favOnly = $("libFavOnly").checked;
    return RT.lib.items.filter((i) =>
      (!cat || i.category === cat) &&
      (type === "all" || i.type === type) &&
      (!favOnly || STORE.favorites.has("bg", i.id)) &&
      (!q || i.title.toLowerCase().includes(q) || i.author.toLowerCase().includes(q) || String(LIB.CATEGORIES[i.category]).includes(q)));
  }

  function cardHtml(i) {
    const src = esc(LIB.itemUrl(i));
    const media = i.type === "video"
      ? `<video class="media" src="${src}" muted playsinline preload="metadata"></video>`
      : `<img class="media" src="${src}" alt="${esc(i.title)}" loading="lazy">`;
    return `<article class="lib-card" data-id="${esc(i.id)}">
      ${media}
      <strong>${esc(i.title)}</strong>
      <div class="meta">${esc(LIB.CATEGORIES[i.category] || "")} · ${i.type === "video" ? "فيديو" : "صورة"}<br>المؤلف: ${esc(i.author)}<br>المصدر: ${esc(i.source)}<br>الترخيص: ${esc(i.license)}</div>
      <div class="chips">
        <button data-act="lib-add" class="primary">إضافة للمحرر</button>
        <button data-act="lib-preview">معاينة</button>
        <button data-act="lib-fav" class="${STORE.favorites.has("bg", i.id) ? "on" : ""}">★</button>
      </div>
    </article>`;
  }

  function renderLibrary() {
    const all = RT.lib.items;
    const list = filteredLibrary();
    let st = all.length ? `عدد الخلفيات: ${toAr(all.length)}` : "";
    if (all.length && list.length !== all.length) st += ` · المعروض: ${toAr(list.length)}`;
    if (RT.lib.errors.length) st += ` · استُبعد ${toAr(RT.lib.errors.length)} عنصر ببيانات ناقصة (الترخيص أو المصدر أو المؤلف).`;
    setStatus("libStatus", st, RT.lib.errors.length ? "warn" : "");
    $("libGrid").innerHTML = !all.length
      ? `<div class="empty-box">المكتبة فاضية حالياً. لا نضيف أي صورة أو فيديو إلا بعد التحقق من ترخيصه. أضف الملفات إلى مجلد backgrounds/ وسجّل ترخيص كل ملف في manifest.json (التفاصيل في backgrounds/LICENSES.md). وفي الأثناء يمكنك رفع خلفياتك من خطوة التصميم.</div>`
      : !list.length
        ? `<div class="empty-box">لا توجد خلفيات تطابق الفلاتر.</div>`
        : list.map(cardHtml).join("");
    const recent = STORE.recent.list().map(libItemById).filter(Boolean);
    $("libRecent").innerHTML = recent.length
      ? recent.map((i) => `<button data-act="lib-preview" data-id="${esc(i.id)}">${esc(i.title)}</button>`).join("")
      : `<span class="hint">لا شيء بعد.</span>`;
  }

  function previewLibrary(item) {
    const box = $("libPreview");
    const src = esc(LIB.itemUrl(item));
    const media = item.type === "video"
      ? `<video src="${src}" controls muted loop playsinline></video>`
      : `<img src="${src}" alt="${esc(item.title)}">`;
    box.innerHTML = `${media}
      <strong>${esc(item.title)}</strong>
      <div class="hint">المؤلف: ${esc(item.author)} · المصدر: ${esc(item.source)} · الترخيص: ${esc(item.license)}</div>
      <div class="chips">
        <button data-act="lib-add" data-id="${esc(item.id)}" class="primary">إضافة للمحرر</button>
        <button data-act="lib-fav" data-id="${esc(item.id)}">★ مفضلة</button>
        <button data-act="lib-close">إغلاق</button>
      </div>`;
    box.hidden = false;
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function toggleLibFav(item) {
    const on = STORE.favorites.toggle("bg", item.id);
    toast(on ? "أُضيفت للمفضلة." : "أُزيلت من المفضلة.", "info");
    renderLibrary();
    renderFavorites();
    renderBgList();
  }

  async function loadLibrary() {
    RT.lib = await LIB.loadManifest();
    renderLibrary();
    await rehydrateLibrary();
  }

  // ---------- القرّاء ----------
  function renderReadersPage() {
    const q = $("recPageQ").value.trim().toLowerCase();
    const list = RT.readers.filter((r) => !q || String(r.name || "").toLowerCase().includes(q));
    setStatus(
      "recStatus",
      RT.readers.length ? `عدد القرّاء: ${toAr(RT.readers.length)}` : "قائمة القرّاء ما تحمّلت بعد. تحقق من الاتصال.",
      RT.readers.length ? "" : "warn"
    );
    $("recList").innerHTML = list.length
      ? list.map((r) => `<li data-id="${esc(String(r.id))}">
          <span class="name"><strong>${esc(r.name)}</strong>${r.rewaya ? `<br><span class="hint">الرواية: ${esc(r.rewaya)}</span>` : ""}</span>
          <button data-act="rec-fav" class="${STORE.favorites.has("reciters", r.id) ? "on" : ""}">★</button>
          <button data-act="rec-use" class="primary">استخدام في المحرر</button>
        </li>`).join("")
      : `<li class="empty">لا يوجد قارئ يطابق البحث.</li>`;
  }

  function useReaderInEditor(r) {
    S.readerId = String(r.id);
    S.readerName = r.name || "";
    if (!S.reciterName.trim()) S.reciterName = r.name || "";
    $("readerQ").value = "";
    showView("create");
    goStep(1);
    onChange("reader");
    toast(`اخترت القارئ: ${r.name}. اضغط "جلب الصوت والتوقيت" لتحميل السورة.`, "info");
  }

  // ---------- المفضلة ----------
  function renderFavorites() {
    const bgs = STORE.favorites.list("bg").map(libItemById).filter(Boolean);
    $("favBg").innerHTML = bgs.length
      ? bgs.map((i) => `<li data-id="${esc(i.id)}"><span class="name">${esc(i.title)} <span class="hint">· ${esc(LIB.CATEGORIES[i.category] || "")}</span></span><button data-act="fav-add" class="primary">إضافة للمحرر</button><button data-act="fav-rm">إزالة</button></li>`).join("")
      : `<li class="empty">لا توجد خلفيات مفضلة. أضفها من مكتبة الخلفيات.</li>`;
    const recs = STORE.favorites.list("reciters");
    $("favRec").innerHTML = recs.length
      ? recs.map((id) => {
          const r = RT.readers.find((x) => String(x.id) === id);
          const label = r ? `${esc(r.name)}${r.rewaya ? `<br><span class="hint">الرواية: ${esc(r.rewaya)}</span>` : ""}` : `قارئ رقم ${esc(id)} (تحقق من القائمة لاحقاً)`;
          return `<li data-id="${esc(id)}"><span class="name">${label}</span>${r ? '<button data-act="rec-use" class="primary">استخدام في المحرر</button>' : ""}<button data-act="rec-rm">إزالة</button></li>`;
        }).join("")
      : `<li class="empty">لا يوجد قرّاء مفضلون.</li>`;
  }

  // ---------- الإعدادات ----------
  async function refreshStorageInfo() {
    const parts = [];
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        if (est.usage != null && est.quota) parts.push(`المستخدم: ${mbText(est.usage)} من ${mbText(est.quota)}`);
      }
    } catch (_) { /* غير متوفر في هذا المتصفح */ }
    try {
      parts.push(`المسودات: ${toAr(await DB.countProjects())} من ${toAr(DB.MAX_DRAFTS)}`);
    } catch (_) { /* تجاهل */ }
    setStatus("storageInfo", parts.join(" · ") || "معلومات التخزين غير متوفرة في هذا المتصفح.");
  }

  function renderSettings() {
    const p = STORE.prefs.get();
    $("setTheme").value = p.theme === "light" ? "light" : "dark";
    $("setAspect").value = p.defaults.aspect;
    $("setRes").value = String(p.defaults.res);
    $("setLight").checked = !!p.defaults.lightMode;
    $("setCacheAudio").checked = !!p.cacheAudio;
    renderHistoryLists();
    refreshStorageInfo();
  }

  function saveDefaultsFromUi() {
    STORE.prefs.set({
      defaults: { aspect: $("setAspect").value, res: Number($("setRes").value), lightMode: $("setLight").checked },
    });
    toast("حُفظت الإعدادات الافتراضية للمشاريع الجديدة.", "info");
  }

  // يمسح نص القرآن والتفسير والترجمات وقائمة القرّاء والصوت المحفوظ. المسودات والخط المرفوع يبقون.
  async function clearCaches() {
    try {
      await DB.cacheClear((k) => /^(quran|ed|readers):/.test(k));
      if (typeof caches !== "undefined") await caches.delete(SV.AUDIO_CACHE);
      toast("تم مسح الكاش. النص والتفسير والقرّاء تُجلب من جديد عند الحاجة.", "info");
      refreshStorageInfo();
    } catch (err) {
      toast(`تعذّر مسح الكاش: ${err.message}`, "error");
    }
  }

  // ---------- النسخ الاحتياطي (ملف JSON يشمل المسودات والملفات المرفوعة والمفضلة) ----------
  async function buildBackup() {
    const rows = await DB.listProjects();
    const drafts = [];
    let bytes = 0;
    for (const row of rows) {
      const { project, media } = await DB.getProject(row.id);
      const files = [];
      for (const m of media) {
        if (!m.blob) continue;
        bytes += m.blob.size;
        files.push({ refId: m.refId, role: m.role, name: m.name, type: m.type, data: await blobToBase64(m.blob) });
      }
      drafts.push({
        project: { name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, summary: project.summary, state: project.state },
        media: files,
      });
    }
    return {
      bytes,
      data: { format: "inaba-backup", version: 1, exportedAt: new Date().toISOString(), favorites: STORE.favorites.all(), drafts },
    };
  }

  async function exportBackup() {
    const btn = $("backupExportBtn");
    btn.disabled = true;
    setStatus("backupStatus", "جاري تجهيز النسخة...");
    try {
      const { bytes, data } = await buildBackup();
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const name = `inaba-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const big = bytes > 150 * 1048576 ? " النسخة كبيرة، وبعض الأجهزة ما تقدر تحفظها كاملة." : "";
      if (nativeBridge) {
        const where = await saveToDevice(blob, name);
        setStatus("backupStatus", `تم حفظ النسخة في: ${where}.${big}`, big ? "warn" : "ok");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus("backupStatus", `تم تجهيز الملف للتحميل: ${name}.${big}`, big ? "warn" : "ok");
      }
      STORE.history.add("backup", name);
      renderHistoryLists();
    } catch (err) {
      setStatus("backupStatus", `تعذّر التصدير: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
    }
  }

  function base64ToBlob(b64, type) {
    const bin = atob(String(b64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || "application/octet-stream" });
  }

  async function importBackup(file) {
    setStatus("backupStatus", "جاري قراءة الملف...");
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      data = null;
    }
    if (!data || data.format !== "inaba-backup" || data.version !== 1 || !Array.isArray(data.drafts)) {
      return setStatus("backupStatus", "هذا الملف ليس نسخة احتياطية من إنابة، أو إصداره غير مدعوم.", "error");
    }
    const room = Math.max(0, DB.MAX_DRAFTS - (await DB.countProjects()));
    const take = data.drafts.slice(0, room);
    let saved = 0;
    try {
      for (const d of take) {
        const p = d && typeof d.project === "object" && d.project ? d.project : {};
        const media = (Array.isArray(d.media) ? d.media : []).map((m) => ({
          refId: String(m.refId),
          role: String(m.role || "bg"),
          name: String(m.name || ""),
          type: String(m.type || ""),
          blob: base64ToBlob(m.data, m.type),
        }));
        const now = Date.now();
        await DB.saveProject({
          id: uid(),
          name: String(p.name || "مسودة مستوردة"),
          createdAt: now,
          updatedAt: now,
          summary: typeof p.summary === "object" && p.summary ? p.summary : {},
          state: typeof p.state === "object" && p.state ? p.state : {},
        }, media);
        saved++;
      }
    } catch (err) {
      renderDrafts();
      return setStatus("backupStatus", `توقّف الاستيراد بعد ${toAr(saved)} مسودة: ${err.message}`, "error");
    }
    const fav = data.favorites && typeof data.favorites === "object" ? data.favorites : {};
    for (const kind of ["bg", "reciters"]) {
      for (const id of Array.isArray(fav[kind]) ? fav[kind] : []) {
        if (typeof id === "string" && id && !STORE.favorites.has(kind, id)) STORE.favorites.toggle(kind, id);
      }
    }
    const skipped = data.drafts.length - take.length;
    STORE.history.add("restore", `${toAr(saved)} مسودة`);
    renderDrafts();
    renderHome();
    renderFavorites();
    renderHistoryLists();
    setStatus(
      "backupStatus",
      `تم استيراد ${toAr(saved)} مسودة.` + (skipped > 0 ? ` تم تخطي ${toAr(skipped)} لأن الحد ${toAr(DB.MAX_DRAFTS)} مسودة.` : ""),
      skipped > 0 ? "warn" : "ok"
    );
  }

  // ---------- الخط المرفوع من المستخدم ----------
  function addUserFontOptions() {
    const has = !!RT.userFace;
    for (const sel of document.querySelectorAll('select[data-bind="design.fontFamily"], select[data-bind="tafsir.family"]')) {
      const old = sel.querySelector(`option[value="${USER_FONT}"]`);
      if (old) old.remove();
      if (has) {
        const opt = document.createElement("option");
        opt.value = USER_FONT;
        opt.textContent = "خط مرفوع من جهازك";
        sel.appendChild(opt);
      }
    }
    $("removeFontBtn").hidden = !has;
  }

  async function applyUserFont(blob, name) {
    const url = URL.createObjectURL(blob);
    try {
      const face = new FontFace(USER_FONT, `url(${url})`);
      await face.load();
      document.fonts.add(face);
      if (RT.userFace) document.fonts.delete(RT.userFace);
      RT.userFace = face;
    } finally {
      URL.revokeObjectURL(url);
    }
    R.registerFont(USER_FONT);
    addUserFontOptions();
    setStatus("fontStatus", `الخط "${name}" جاهز.`, "ok");
    RT.version++;
    syncInputs();
  }

  async function onFontFile() {
    const file = $("fontFile").files[0];
    $("fontFile").value = "";
    if (!file) return;
    if (file.size > 8 * 1048576) return setStatus("fontStatus", "حجم الخط أكبر من 8 ميغابايت.", "error");
    setStatus("fontStatus", "جاري تحميل الخط...");
    try {
      await applyUserFont(file, file.name);
      await DB.cachePut("font:user", { blob: file, name: file.name });
      S.design.fontFamily = USER_FONT;
      onChange("design");
    } catch (err) {
      setStatus("fontStatus", `تعذّر استخدام هذا الملف كخط (${err.message}). جرّب TTF أو OTF أو WOFF.`, "error");
    }
  }

  async function removeUserFont() {
    try {
      await DB.cacheDelete("font:user");
    } catch (_) { /* تجاهل: الخط يُزال من الواجهة على أي حال */ }
    if (RT.userFace) document.fonts.delete(RT.userFace);
    RT.userFace = null;
    if (S.design.fontFamily === USER_FONT) S.design.fontFamily = "Amiri Quran";
    if (S.tafsir.family === USER_FONT) S.tafsir.family = "Noto Naskh Arabic";
    addUserFontOptions();
    setStatus("fontStatus", "حُذف الخط المرفوع.", "ok");
    onChange("design");
  }

  async function loadUserFont() {
    try {
      const row = await DB.cacheGet("font:user");
      if (row && row.blob) await applyUserFont(row.blob, row.name || "خط مرفوع");
    } catch (_) { /* الخط اختياري */ }
    addUserFontOptions();
    syncInputs();
  }

  // ---------- ربط أزرار الصفحات الجديدة ----------
  function bindPages() {
    document.querySelectorAll("[data-go-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.goView)));

    // الرئيسية والمشروع الجديد
    [$("homeNewBtn"), $("newProjectBtn")].forEach((btn) => btn.addEventListener("click", () => {
      if (confirmTwice(btn, "تأكيد؟ يفرغ المحرر")) newProject();
    }));
    $("homeDrafts").addEventListener("click", (e) => {
      const b = e.target.closest('button[data-act="open"]');
      if (b) openDraft(b.closest("li").dataset.id);
    });

    // المكتبة
    $("libCat").insertAdjacentHTML("beforeend", Object.entries(LIB.CATEGORIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""));
    $("libQ").addEventListener("input", renderLibrary);
    ["libCat", "libType", "libFavOnly"].forEach((id) => $(id).addEventListener("change", renderLibrary));
    $("libRandom").addEventListener("click", () => {
      const list = filteredLibrary();
      if (!list.length) return toast("ما فيه خلفيات تطابق الفلاتر.", "error");
      previewLibrary(list[Math.floor(Math.random() * list.length)]);
    });
    document.querySelector('[data-view-panel="library"]').addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "lib-close") {
        $("libPreview").hidden = true;
        return;
      }
      const holder = btn.closest("[data-id]");
      const item = holder && libItemById(holder.dataset.id);
      if (!item) return;
      if (btn.dataset.act === "lib-add") addLibraryItem(item);
      if (btn.dataset.act === "lib-preview") previewLibrary(item);
      if (btn.dataset.act === "lib-fav") toggleLibFav(item);
    });

    // القرّاء
    $("recPageQ").addEventListener("input", renderReadersPage);
    $("recList").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      const btn = e.target.closest("button[data-act]");
      if (!li || !btn) return;
      const r = RT.readers.find((x) => String(x.id) === li.dataset.id);
      if (!r) return;
      if (btn.dataset.act === "rec-fav") {
        STORE.favorites.toggle("reciters", r.id);
        renderReadersPage();
        renderFavorites();
      }
      if (btn.dataset.act === "rec-use") useReaderInEditor(r);
    });

    // المفضلة
    $("favBg").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      const btn = e.target.closest("button[data-act]");
      const item = li && libItemById(li.dataset.id);
      if (!item || !btn) return;
      if (btn.dataset.act === "fav-add") addLibraryItem(item);
      if (btn.dataset.act === "fav-rm") toggleLibFav(item);
    });
    $("favRec").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      const btn = e.target.closest("button[data-act]");
      if (!li || !btn) return;
      if (btn.dataset.act === "rec-rm") {
        STORE.favorites.toggle("reciters", li.dataset.id);
        renderFavorites();
        renderReadersPage();
      }
      if (btn.dataset.act === "rec-use") {
        const r = RT.readers.find((x) => String(x.id) === li.dataset.id);
        if (r) useReaderInEditor(r);
      }
    });

    // الإعدادات
    $("setTheme").addEventListener("change", () => applyTheme($("setTheme").value));
    ["setAspect", "setRes", "setLight"].forEach((id) => $(id).addEventListener("change", saveDefaultsFromUi));
    $("setCacheAudio").addEventListener("change", () => STORE.prefs.set({ cacheAudio: $("setCacheAudio").checked }));
    $("clearCacheBtn").addEventListener("click", (e) => {
      if (confirmTwice(e.currentTarget, "تأكيد المسح؟")) clearCaches();
    });
    $("backupExportBtn").addEventListener("click", exportBackup);
    $("backupFile").addEventListener("change", () => {
      const f = $("backupFile").files[0];
      $("backupFile").value = "";
      if (f) importBackup(f);
    });
    $("histClearBtn").addEventListener("click", (e) => {
      if (confirmTwice(e.currentTarget, "تأكيد المسح؟")) {
        STORE.history.clear();
        renderHistoryLists();
      }
    });

    // الخط المرفوع
    $("fontFile").addEventListener("change", onFontFile);
    $("removeFontBtn").addEventListener("click", (e) => {
      if (confirmTwice(e.currentTarget, "تأكيد الحذف؟")) removeUserFont();
    });
  }

  // ---------- بدء التشغيل ----------
  function init() {
    const hadFiles = restoreEditor();
    applyTheme(STORE.prefs.get().theme === "light" ? "light" : "dark");
    bindControls();
    bindPages();
    syncInputs();
    renderAll();
    goStep(S.step);
    showView("home");
    if (hadFiles) {
      toast("الملفات المرفوعة (صور، فيديو، صوت) ما تبقى بعد إعادة التحميل. احفظ مسودة لتبقى الملفات.", "info");
    }
    R.preloadFonts().then(() => { RT.version++; });
    audio.volume = clamp(S.volume, 0, 100) / 100;
    renderSurahOptions();
    syncInputs();
    loadQuranData();
    loadReaders();
    loadLibrary();
    loadUserFont();
    renderDrafts();
    requestAnimationFrame(frame);
  }

  init();
})();
