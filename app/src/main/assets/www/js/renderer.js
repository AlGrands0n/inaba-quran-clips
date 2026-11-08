/*
 * محرّك الرسم: نفس الدالة تُستخدم للمعاينة والتصدير، فالمعاينة تطابق الفيديو المُصدَّر.
 * الدالة draw(ctx, scene, t) ترسم إطاراً واحداً عند الزمن t (بالثواني).
 *
 * شكل scene (يبنيه app.js):
 *   w, h, unit, version, duration, light (وضع خفيف)
 *   design:   إعدادات الخط والشكل (من حالة التطبيق مباشرة)
 *   tafsir:   {on, family, size, color, pos, align, bgOpacity, label}
 *   trans:    {on, family, rtl, size, color, pos, align}
 *   look:     {brightness, contrast, saturation, blur, darkness, overlay}   (نسب مئوية)
 *   motion:   {mode: 'in'|'out'|'pan'|'none', amount: 0..1}
 *   bg:       {items: [{type:'image'|'video'|'solid', el, color}], interval, fallback}
 *   segments: [{number, surah, text, start, end, translation, tafsir}]
 *   title, subtitle, reciterName, brand, transLabel
 */
(function (root) {
  "use strict";

  const GOLD = "#e8c968";
  const FONTS = {
    "Amiri Quran": '"Amiri Quran", Amiri, serif',
    "Amiri": 'Amiri, "Amiri Quran", serif',
    "Scheherazade New": '"Scheherazade New", Amiri, serif',
    "Noto Naskh Arabic": '"Noto Naskh Arabic", Amiri, serif',
    "Noto Sans": '"Noto Sans", Arial, sans-serif',
  };
  // الخطوط اللي لازم تنحمّل قبل الرسم (الكانفس ما ينتظر خطوط الويب تلقائياً)
  const FONT_SPECS = [
    '400 40px "Amiri Quran"',
    '400 40px Amiri',
    '700 40px Amiri',
    '400 40px "Scheherazade New"',
    '400 40px "Noto Naskh Arabic"',
    '700 40px "Noto Naskh Arabic"',
    '400 40px "Noto Sans"',
  ];

  const toAr = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  function font(family, px, weight) {
    return `${weight || 400} ${Math.max(8, Math.round(px))}px ${FONTS[family] || FONTS.Amiri}`;
  }

  function setFont(ctx, css, spacing) {
    ctx.font = css;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing || 0}px`;
  }

  // تقسيم النص إلى أسطر ضمن عرض maxW (يستخدم خط ctx الحالي)
  function wrap(ctx, text, maxW) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxW) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function widestLine(ctx, lines) {
    let width = 0;
    for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
    return width;
  }

  function hexA(hex, alphaPct) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    const v = m ? m[1] : "000000";
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${clamp(num(alphaPct, 100), 0, 100) / 100})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // عنوان قصير: نصغّر الخط لو عرضه تجاوز المساحة
  function fitSingleLine(ctx, text, family, px, weight, maxW) {
    let size = px;
    let css = font(family, size, weight);
    setFont(ctx, css, 0);
    while (size > 12 && ctx.measureText(text).width > maxW) {
      size *= 0.92;
      css = font(family, size, weight);
      setFont(ctx, css, 0);
    }
    return css;
  }

  // ---------- تخطيط النص (يُحسب مرة لكل آية وإعدادات) ----------
  function buildStack(ctx, sc, seg, s, maxW) {
    const d = sc.design;
    const unit = sc.unit;
    const spacing = num(d.letterSpacing, 0);
    const vpx = unit * 0.062 * (num(d.fontSize, 100) / 100) * s;
    const vlh = vpx * (num(d.lineHeight, 180) / 100);
    const vcss = font(d.fontFamily, vpx);

    let verseText = seg.text;
    if (d.numberStyle === "paren") verseText += ` (${toAr(seg.number)})`;
    setFont(ctx, vcss, spacing);
    const vLines = wrap(ctx, verseText, maxW);
    const markerR = unit * 0.024;
    const markerH = d.numberStyle === "circle" ? markerR * 2 + unit * 0.02 : 0;
    const verse = {
      kind: "verse", lines: vLines, css: vcss, px: vpx, lh: vlh, spacing,
      color: d.color, align: d.align, rtl: true,
      h: vLines.length * vlh + markerH,
      w: widestLine(ctx, vLines),
    };
    const blocks = [verse];

    const tr = sc.trans;
    if (tr && tr.on && seg.translation) {
      const tpx = unit * 0.032 * (num(tr.size, 100) / 100) * s;
      const tlh = tpx * 1.5;
      const tcss = font(tr.family, tpx);
      setFont(ctx, tcss, 0);
      const tLines = wrap(ctx, seg.translation, maxW);
      const trans = {
        kind: "trans", lines: tLines, css: tcss, px: tpx, lh: tlh, spacing: 0,
        color: tr.color, align: tr.align, rtl: !!tr.rtl,
        h: tLines.length * tlh, w: widestLine(ctx, tLines),
      };
      if (tr.pos === "above") blocks.unshift(trans);
      else blocks.push(trans);
    }

    const gap = blocks.length > 1 ? unit * 0.025 : 0;
    const totalH = blocks.reduce((a, b) => a + b.h, 0) + gap * (blocks.length - 1);
    const width = Math.max(...blocks.map((b) => b.w));
    return { blocks, gap, totalH, width, markerR, markerH, verseLinesH: vLines.length * vlh };
  }

  function fitTafsir(ctx, sc, seg, maxW, inner) {
    const T = sc.tafsir;
    const unit = sc.unit;
    for (let s2 = 1; s2 >= 0.45 - 1e-6; s2 -= 0.05) {
      const px = unit * 0.028 * (num(T.size, 100) / 100) * s2;
      const css = font(T.family, px);
      const lh = px * 1.6;
      setFont(ctx, css, 0);
      const lines = wrap(ctx, seg.tafsir, maxW);
      if (lines.length * lh <= inner) return { lines, css, px, lh, overflow: false };
    }
    const px = unit * 0.028 * (num(T.size, 100) / 100) * 0.45;
    const css = font(T.family, px);
    setFont(ctx, css, 0);
    const lh = px * 1.6;
    return { lines: wrap(ctx, seg.tafsir, maxW), css, px, lh, overflow: true };
  }

  function computeLayout(ctx, sc, seg) {
    const d = sc.design;
    const { w, h, unit } = sc;
    const pad = unit * 0.03;
    const boxOn = !!d.boxOn;
    const frameOn = !!d.frame && d.frame !== "none";
    const inset = boxOn || frameOn ? pad : 0;
    const maxW = w * 0.8 - inset * 2;

    const T = sc.tafsir;
    const hasTafsir = !!(T && T.on && seg.tafsir);
    // شريحة التفسير تأخذ مكاناً ثابتاً أعلى أو أسفل الشاشة، والنص يتمركز في الباقي
    let areaTop = h * 0.2;
    let areaBottom = h * 0.8;
    let slot = null;
    if (hasTafsir) {
      if (T.pos === "top") {
        slot = [h * 0.2, h * 0.37];
        areaTop = slot[1] + unit * 0.02;
      } else {
        slot = [h * 0.62, h * 0.82];
        areaBottom = slot[0] - unit * 0.02;
      }
    }
    const areaH = areaBottom - areaTop;

    let stack = null;
    let overflow = false;
    for (let s = 1; s >= 0.45 - 1e-6; s -= 0.05) {
      const candidate = buildStack(ctx, sc, seg, s, maxW);
      if (candidate.totalH <= areaH) {
        stack = candidate;
        break;
      }
    }
    if (!stack) {
      stack = buildStack(ctx, sc, seg, 0.45, maxW);
      overflow = true;
    }

    const mid = (areaTop + areaBottom) / 2;
    const maxTop = Math.max(areaTop, areaBottom - stack.totalH);
    let top;
    if (d.textPos === "top") top = areaTop;
    else if (d.textPos === "bottom") top = maxTop;
    else if (d.textPos === "custom") top = clamp(h * num(d.customY, 50) / 100 - stack.totalH / 2, areaTop, maxTop);
    else top = clamp(mid - stack.totalH / 2, areaTop, maxTop);

    let y = top;
    const blocks = stack.blocks.map((b) => {
      const placed = { ...b, y };
      y += b.h + stack.gap;
      return placed;
    });

    const box = boxOn || frameOn
      ? { x: w / 2 - stack.width / 2 - pad, y: top - pad, w: stack.width + pad * 2, h: stack.totalH + pad * 2 }
      : null;

    const verseBlock = blocks.find((b) => b.kind === "verse");
    const marker = d.numberStyle === "circle" && verseBlock
      ? { x: w / 2, y: verseBlock.y + stack.verseLinesH + unit * 0.01 + stack.markerR, r: stack.markerR }
      : null;

    let tafsir = null;
    if (hasTafsir) {
      const labelPx = unit * 0.024;
      const labelCss = font("Noto Naskh Arabic", labelPx, 700);
      // لا نحجز مكان العنوان إذا كان مخفياً
      const labelH = T.label ? labelPx * 1.8 : 0;
      const inner = slot[1] - slot[0] - pad * 2 - labelH;
      const fit = fitTafsir(ctx, sc, seg, w * 0.8, inner);
      if (fit.overflow) overflow = true;
      tafsir = {
        slot, labelCss, labelH, label: T.label || "", pad,
        css: fit.css, lh: fit.lh, lines: fit.lines,
        color: T.color, align: T.align, bgOpacity: num(T.bgOpacity, 35),
      };
    }

    return { blocks, box, marker, tafsir, width: stack.width, overflow, areaTop, areaBottom };
  }

  let memo = { key: "", value: null };
  function layoutFor(ctx, sc, seg) {
    const key = [sc.version, seg.surah, seg.number, seg.text.length, (seg.translation || "").length, (seg.tafsir || "").length].join("|");
    if (memo.key !== key) memo = { key, value: computeLayout(ctx, sc, seg) };
    return memo.value;
  }

  // ---------- الرسم ----------
  function filterString(look, light) {
    const b = num(look.brightness, 100);
    const c = num(look.contrast, 100);
    const s = num(look.saturation, 100);
    const bl = light ? 0 : num(look.blur, 0);
    if (b === 100 && c === 100 && s === 100 && bl === 0) return "";
    return `brightness(${b}%) contrast(${c}%) saturate(${s}%) blur(${bl}px)`;
  }

  function bgIndex(bg, t) {
    const n = bg.items.length;
    if (!n) return -1;
    return Math.floor(Math.max(0, t) / Math.max(1, bg.interval)) % n;
  }

  function drawBackground(ctx, sc, t) {
    const { w, h } = sc;
    ctx.fillStyle = sc.bg.fallback || "#0c1a22";
    ctx.fillRect(0, 0, w, h);
    const i = bgIndex(sc.bg, t);
    if (i < 0) return;
    const item = sc.bg.items[i];
    if (item.type === "solid") {
      ctx.fillStyle = item.color;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const el = item.el;
    if (!el) return;
    // فيديو لم يفكّ إطاره بعد: لا نرسمه، لأن الإطار الفارغ أو غير المكتمل قد يخرج ملوّناً بالخطأ في التصدير
    if (item.type === "video" && el.readyState < 2) return;
    const sw = item.type === "video" ? el.videoWidth : el.naturalWidth;
    const sh = item.type === "video" ? el.videoHeight : el.naturalHeight;
    if (!sw || !sh) return;

    const interval = Math.max(1, sc.bg.interval);
    const p = (t % interval) / interval; // موقع الخلفية داخل فترتها
    const amt = clamp(sc.motion.amount, 0, 1);
    const mode = sc.motion.mode;
    let scale = Math.max(w / sw, h / sh); // تغطية كاملة للإطار
    if (mode === "in") scale *= 1 + amt * 0.12 * p;
    else if (mode === "out") scale *= 1 + amt * 0.12 * (1 - p);
    const dw = sw * scale;
    const dh = sh * scale;
    let dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    if (mode === "pan") dx += (p - 0.5) * amt * (dw - w);

    ctx.save();
    const f = filterString(sc.look, sc.light);
    if (f) ctx.filter = f;
    ctx.drawImage(el, dx, dy, dw, dh);
    ctx.restore();
  }

  function drawShade(ctx, sc) {
    const { w, h, unit, look } = sc;
    ctx.fillStyle = `rgba(0,0,0,${clamp(num(look.overlay, 30), 0, 100) / 100})`;
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(w / 2, h / 2, unit * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${0.15 + (clamp(num(look.darkness, 35), 0, 100) / 100) * 0.75})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  function drawHeader(ctx, sc) {
    const { w, h, unit } = sc;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.direction = "rtl";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = unit * 0.01;
    if (sc.title) {
      ctx.fillStyle = GOLD;
      fitSingleLine(ctx, sc.title, "Amiri", unit * 0.05, 700, w * 0.9);
      ctx.fillText(sc.title, w / 2, h * 0.075);
    }
    if (sc.subtitle) {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      fitSingleLine(ctx, sc.subtitle, "Amiri", unit * 0.03, 400, w * 0.9);
      ctx.fillText(sc.subtitle, w / 2, h * 0.125);
    }
    ctx.restore();
  }

  function drawFooter(ctx, sc) {
    const { w, h, unit } = sc;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = unit * 0.01;
    if (sc.reciterName) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      fitSingleLine(ctx, sc.reciterName, "Amiri", unit * 0.032, 400, w * 0.9);
      ctx.fillText(sc.reciterName, w / 2, h * 0.87);
    }
    if (sc.brand) {
      ctx.fillStyle = GOLD;
      fitSingleLine(ctx, sc.brand, "Amiri", unit * 0.034, 700, w * 0.9);
      ctx.fillText(sc.brand, w / 2, h * 0.915);
    }
    if (sc.transLabel) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      setFont(ctx, font("Noto Sans", unit * 0.022), 0);
      ctx.fillText(sc.transLabel, w / 2, h * 0.955);
    }
    ctx.restore();
  }

  function drawBlock(ctx, sc, b, rise, width) {
    const align = b.align === "right" ? "right" : b.align === "left" ? "left" : "center";
    const x = align === "center" ? sc.w / 2 : align === "right" ? sc.w / 2 + width / 2 : sc.w / 2 - width / 2;
    setFont(ctx, b.css, b.spacing);
    ctx.fillStyle = b.color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.direction = b.rtl ? "rtl" : "ltr";
    b.lines.forEach((line, i) => ctx.fillText(line, x, b.y + rise + b.lh / 2 + i * b.lh));
    ctx.direction = "inherit";
  }

  function drawFrame(ctx, sc, box, rise, style) {
    const inset = sc.unit * 0.012;
    const x = box.x - inset;
    const y = box.y + rise - inset;
    const w = box.w + inset * 2;
    const h = box.h + inset * 2;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = Math.max(2, sc.unit * 0.003);
    roundRect(ctx, x, y, w, h, sc.unit * 0.01);
    ctx.stroke();
    if (style === "double") {
      const o = inset * 0.9;
      roundRect(ctx, x - o, y - o, w + o * 2, h + o * 2, sc.unit * 0.01);
      ctx.stroke();
    }
  }

  function drawTafsir(ctx, sc, T, a) {
    const { w, unit } = sc;
    const [y0, y1] = T.slot;
    const boxH = y1 - y0;
    ctx.save();
    ctx.globalAlpha = a;
    if (T.bgOpacity > 0) {
      ctx.fillStyle = hexA("#000000", T.bgOpacity);
      roundRect(ctx, w * 0.1, y0, w * 0.8, boxH, unit * 0.02);
      ctx.fill();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.direction = "rtl";
    if (T.label) {
      setFont(ctx, T.labelCss, 0);
      ctx.fillStyle = GOLD;
      ctx.fillText(T.label, w / 2, y0 + T.pad + T.labelH / 2);
    }
    const bodyTop = y0 + T.pad + T.labelH;
    const innerH = boxH - T.pad * 2 - T.labelH;
    const bodyH = T.lines.length * T.lh;
    const first = bodyTop + (innerH - bodyH) / 2 + T.lh / 2;
    const align = T.align === "right" ? "right" : T.align === "left" ? "left" : "center";
    const x = align === "center" ? w / 2 : align === "right" ? w * 0.9 : w * 0.1;
    setFont(ctx, T.css, 0);
    ctx.fillStyle = T.color;
    ctx.textAlign = align;
    T.lines.forEach((line, i) => ctx.fillText(line, x, first + i * T.lh));
    ctx.restore();
  }

  function drawSegment(ctx, sc, seg, t, L) {
    const d = sc.design;
    const fade = Math.max(0.05, num(d.fadeMs, 400) / 1000);
    const fin = clamp((t - seg.start) / fade, 0, 1);
    const fout = clamp((seg.end - t) / fade, 0, 1);
    const a = Math.min(fin, fout);
    if (a <= 0) return;
    const rise = (1 - fin) * sc.unit * 0.02;
    const opacity = clamp(num(d.opacity, 100), 0, 100) / 100;

    ctx.save();
    if (L.box) {
      ctx.globalAlpha = a;
      if (d.boxOn) {
        ctx.fillStyle = hexA(d.boxColor, d.boxOpacity);
        roundRect(ctx, L.box.x, L.box.y + rise, L.box.w, L.box.h, sc.unit * 0.02);
        ctx.fill();
      }
      if (d.frame && d.frame !== "none") drawFrame(ctx, sc, L.box, rise, d.frame);
    }

    ctx.globalAlpha = a * opacity;
    if (d.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = sc.unit * 0.012;
    }
    for (const b of L.blocks) drawBlock(ctx, sc, b, rise, L.width);
    ctx.shadowBlur = 0;

    if (L.marker) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = Math.max(2, sc.unit * 0.0025);
      ctx.beginPath();
      ctx.arc(L.marker.x, L.marker.y + rise, L.marker.r, 0, Math.PI * 2);
      ctx.stroke();
      setFont(ctx, font(d.fontFamily, L.marker.r * 1.1), 0);
      ctx.fillStyle = GOLD;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(toAr(seg.number), L.marker.x, L.marker.y + rise + L.marker.r * 0.05);
    }
    ctx.restore();

    if (L.tafsir) drawTafsir(ctx, sc, L.tafsir, a);
  }

  function drawProgress(ctx, sc, t) {
    ctx.save();
    ctx.fillStyle = GOLD;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(0, sc.h - 6, sc.w * clamp(t / sc.duration, 0, 1), 6);
    ctx.restore();
  }

  function activeSegment(segments, t) {
    for (const s of segments) if (t >= s.start && t < s.end) return s;
    return null;
  }

  // الدالة الرئيسية: إطار واحد عند الزمن t
  function draw(ctx, sc, t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    drawBackground(ctx, sc, t);
    drawShade(ctx, sc);
    drawHeader(ctx, sc);
    const seg = activeSegment(sc.segments, t);
    if (seg) drawSegment(ctx, sc, seg, t, layoutFor(ctx, sc, seg));
    drawFooter(ctx, sc);
    if (sc.duration > 0) drawProgress(ctx, sc, t);
    ctx.globalAlpha = 1;
  }

  function preloadFonts() {
    if (!root.document || !document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all(FONT_SPECS.map((spec) => document.fonts.load(spec).catch(() => null)));
  }

  // يسجّل خطاً مرفوعاً من المستخدم (بعد تحميله بـ FontFace) حتى يتاح في قائمة الخطوط
  function registerFont(family) {
    FONTS[family] = `"${family}", Amiri, serif`;
  }

  root.InabaRenderer = { draw, bgIndex, activeSegment, preloadFonts, registerFont, FONTS, toAr };
  if (typeof module !== "undefined" && module.exports) module.exports = root.InabaRenderer;
})(typeof window !== "undefined" ? window : globalThis);
