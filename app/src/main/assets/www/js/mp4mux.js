/*
 * كاتب MP4 بتخطيط كلاسيكي (moov قبل mdat) وفهرس ملفات MP3. دوال نقية بدون متصفح، فتُختبر في Node.
 *
 * - الفيديو: H.264 بصيغة AVCC (كما يخرجها VideoEncoder مع avc.format = "avc").
 * - الصوت: AAC-LC خام (كما يخرجها AudioEncoder)، مع AudioSpecificConfig من الـ metadata.
 * - الملف: ftyp ثم moov كامل فيه جداول العينات (stts, stss, stsc, stsz, stco) ثم mdat.
 *   هذا هو الشكل الذي تفهمه معارض أندرويد ومدراء الملفات ومشغّلات الفيديو من أول قراءة:
 *   المدة وعدد العينات والأبعاد معروفة قبل بيانات الصور.
 *
 * الكاتب يجمع العينات أثناء الترميز، ويكتب الملف كله مرة واحدة في finish().
 */
(function (root) {
  "use strict";

  const VIDEO_TIMESCALE = 90000; // يقبل القسمة على 24 و25 و30 و60 بدون كسور
  const AAC_FRAME = 1024;
  const MAX_OFFSET = 0xffffffff; // جداول stco تستخدم أوفست 32 بت

  // ---------- بايتات وصناديق ----------
  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const zeros = (n) => new Uint8Array(n);

  function cat(...parts) {
    const list = [];
    const flat = (p) => {
      if (Array.isArray(p)) p.forEach(flat);
      else if (p && p.length) list.push(p);
    };
    flat(parts);
    const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of list) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  const u8 = (...v) => Uint8Array.from(v);
  const u16 = (n) => {
    const d = new DataView(new ArrayBuffer(2));
    d.setUint16(0, n);
    return new Uint8Array(d.buffer);
  };
  const u32 = (n) => {
    const d = new DataView(new ArrayBuffer(4));
    d.setUint32(0, n >>> 0);
    return new Uint8Array(d.buffer);
  };
  // مصفوفة أرقام 32 بت دفعة واحدة (بدون spread، فالمقاطع الطويلة لها آلاف العينات)
  function u32list(nums) {
    const d = new DataView(new ArrayBuffer(nums.length * 4));
    for (let i = 0; i < nums.length; i++) d.setUint32(i * 4, nums[i] >>> 0);
    return new Uint8Array(d.buffer);
  }

  function box(type, ...body) {
    const payload = cat(...body);
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(ascii(type), 4);
    out.set(payload, 8);
    return out;
  }

  const fbox = (type, version, flags, ...body) =>
    box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...body);

  // طول الواصف بصيغة MPEG-4 (بايت واحد لغاية 127، وإلا بايتات بخيط 0x80)
  function descLen(n) {
    const bytesOut = [];
    let v = n;
    do {
      bytesOut.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    return Uint8Array.from(bytesOut.map((b, i) => (i < bytesOut.length - 1 ? b | 0x80 : b)));
  }

  const desc = (tag, ...body) => {
    const payload = cat(...body);
    return cat(u8(tag), descLen(payload.length), payload);
  };

  function esds(trackId, asc) {
    const dsi = desc(0x05, asc);
    const dcd = desc(0x04, u8(0x40, 0x15, 0, 0, 0), u32(0), u32(0), dsi);
    const sl = desc(0x06, u8(0x02));
    return fbox("esds", 0, 0, desc(0x03, u16(trackId), u8(0), dcd, sl));
  }

  const MATRIX = cat(
    u32(0x10000), u32(0), u32(0),
    u32(0), u32(0x10000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  );

  // ---------- وصف العينات (sample entries) ----------
  function sampleEntryAvc(width, height, avcC) {
    return box(
      "avc1",
      zeros(6), u16(1), zeros(16),
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), zeros(4),
      u16(1), zeros(32), u16(0x18), u16(0xffff),
      box("avcC", avcC),
    );
  }

  function sampleEntryAac(channels, sampleRate, asc) {
    // حقل samplerate بصيغة 16.16، وللترددات فوق 65535 نتركه صفراً (يُقرأ من esds)
    const sr16 = sampleRate <= 65535 ? sampleRate * 65536 : 0;
    return box(
      "mp4a",
      zeros(6), u16(1), zeros(8),
      u16(channels), u16(16), u16(0), u16(0),
      u32(sr16),
      esds(2, asc),
    );
  }

  // ---------- مسار: عيناته وقطعه ----------
  /*
   * كل عينة لها حجم ومدة وزمن dts ونوع (مفتاح أو لا). كل مجموعة متتالية من عينات
   * المسار نفسه داخل mdat تُكتب كقطعة (chunk) واحدة، وإزاحتها نسبية لبداية mdat.
   */
  function createTrack(spec) {
    return { ...spec, sizes: [], dts: [], dur: [], keys: [], chunks: [] };
  }

  // مدة كل عينة: الفرق بين dts المتتالية، وآخر عينة مدتها المعطاة
  function sampleDurations(t) {
    const n = t.sizes.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = i + 1 < n ? Math.max(1, t.dts[i + 1] - t.dts[i]) : Math.max(1, t.dur[i]);
    }
    return out;
  }

  // stts: أزواج (عدد، مدة) متتالية
  function sttsBox(durs) {
    const runs = [];
    for (const d of durs) {
      const n = runs.length;
      if (n && runs[n - 1] === d) runs[n - 2]++;
      else runs.push(1, d);
    }
    return fbox("stts", 0, 0, u32(runs.length / 2), u32list(runs));
  }

  // stsc: كل قطعة فيها عدد العينات نفسه تتجمع في سطر واحد
  function stscBox(chunks) {
    const runs = []; // أزواج (أول قطعة، عدد العينات فيها)
    chunks.forEach((c, i) => {
      const n = runs.length;
      if (!n || runs[n - 1] !== c.count) runs.push(i + 1, c.count);
    });
    const rows = [];
    for (let k = 0; k < runs.length; k += 2) rows.push(runs[k], runs[k + 1], 1);
    return fbox("stsc", 0, 0, u32(runs.length / 2), u32list(rows));
  }

  // ---------- صندوق المسار ----------
  function trakFor(t, base) {
    const durs = sampleDurations(t);
    let mediaDur = 0;
    for (const d of durs) mediaDur += d;
    const movieDur = Math.round((mediaDur * 1000) / t.timescale);

    const keyNums = [];
    if (t.isVideo) t.keys.forEach((k, i) => { if (k) keyNums.push(i + 1); });
    const offsets = t.chunks.map((c) => base + c.rel);

    const stbl = box(
      "stbl",
      fbox("stsd", 0, 0, u32(1), t.entry),
      sttsBox(durs),
      ...(t.isVideo ? [fbox("stss", 0, 0, u32(keyNums.length), u32list(keyNums))] : []),
      stscBox(t.chunks),
      fbox("stsz", 0, 0, u32(0), u32(t.sizes.length), u32list(t.sizes)),
      fbox("stco", 0, 0, u32(offsets.length), u32list(offsets)),
    );

    const tkhd = fbox(
      "tkhd", 0, 3,
      u32(0), u32(0), u32(t.id), u32(0), u32(movieDur),
      zeros(8), u16(0), u16(0), u16(t.isVideo ? 0 : 0x0100), u16(0),
      MATRIX, u32(t.isVideo ? t.width * 65536 : 0), u32(t.isVideo ? t.height * 65536 : 0),
    );
    const mdhd = fbox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDur), u16(0x55c4), u16(0));
    const hdlr = fbox("hdlr", 0, 0, u32(0), ascii(t.handler), zeros(12), ascii(t.name), u8(0));
    const dinf = box("dinf", fbox("dref", 0, 0, u32(1), fbox("url ", 0, 1)));
    const minf = box("minf", t.mediaHeader, dinf, stbl);
    return { movieDur, box: box("trak", tkhd, box("mdia", mdhd, hdlr, minf)) };
  }

  const mvhd = (durationMs, nextTrack) =>
    fbox(
      "mvhd", 0, 0,
      u32(0), u32(0), u32(1000), u32(durationMs),
      u32(0x10000), u16(0x100), u16(0), zeros(8),
      MATRIX, zeros(24), u32(nextTrack),
    );

  // moov كامل. base = الأوفست المطلق لبداية بيانات mdat (تدخل في stco)
  function buildMoov(tracks, base) {
    const built = tracks.map((t) => trakFor(t, base));
    const movieDur = Math.max(...built.map((b) => b.movieDur));
    return box("moov", mvhd(movieDur, tracks.length + 1), ...built.map((b) => b.box));
  }

  // ---------- الكاتب ----------
  /*
   * cfg: {width, height, avcC (Uint8Array), audio: {sampleRate, channels, asc} | null}
   *      (المدة تُحسب من العينات الفعلية)
   * addVideo(data, dts, dur, key)  — dts و dur بوحدة 90000 في الثانية
   * addAudio(data, dts, dur)       — dts و dur بوحدة معدل العينة
   * flush(untilSec)                — محفوظة للتوافق، لا تفعل شيئاً: كل شيء يُكتب في finish()
   * finish()                       — يرجّع Blob بالملف كاملاً
   */
  function createMp4Writer(cfg) {
    const video = createTrack({
      id: 1, timescale: VIDEO_TIMESCALE, isVideo: true, width: cfg.width, height: cfg.height,
      handler: "vide", name: "VideoHandler",
      mediaHeader: fbox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
      entry: sampleEntryAvc(cfg.width, cfg.height, cfg.avcC),
    });
    const audio = cfg.audio
      ? createTrack({
        id: 2, timescale: cfg.audio.sampleRate, isVideo: false,
        handler: "soun", name: "SoundHandler",
        mediaHeader: fbox("smhd", 0, 0, u16(0), u16(0)),
        entry: sampleEntryAac(cfg.audio.channels, cfg.audio.sampleRate, cfg.audio.asc),
      })
      : null;

    const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
    const payloads = []; // بيانات العينات بترتيب وصولها داخل mdat
    let dataBytes = 0;
    let open = null; // المسار الذي تُكتب قطعته الحالية

    function put(track, bytes, dts, dur, key) {
      if (open !== track) {
        track.chunks.push({ rel: dataBytes, count: 0 });
        open = track;
      }
      track.chunks[track.chunks.length - 1].count++;
      track.sizes.push(bytes.length);
      track.dts.push(dts);
      track.dur.push(dur);
      track.keys.push(!!key);
      // Blob يحمل البيانات خارج كومة JS، فلا تتراكم مصفوفات كبيرة على الذاكرة
      payloads.push(new Blob([bytes]));
      dataBytes += bytes.length;
    }

    function addVideo(data, dts, dur, key) {
      put(video, data, dts, dur, key);
    }

    function addAudio(data, dts, dur) {
      if (audio) put(audio, data, dts, dur, true);
    }

    function flush() {
      /* للتوافق فقط */
    }

    function finish() {
      if (!video.sizes.length) throw new Error("لا توجد إطارات فيديو للكتابة.");
      const tracks = [video];
      if (audio && audio.sizes.length) tracks.push(audio);

      // نبني moov مرتين: الأولى لمعرفة طوله، والثانية بالأوفست الحقيقي.
      // طول moov ثابت لأن كل الأوفستات بحجم 32 بت.
      const probe = buildMoov(tracks, 0);
      const mdatStart = ftyp.length + probe.length;
      const payloadStart = mdatStart + 8;
      if (payloadStart + dataBytes > MAX_OFFSET) throw new Error("الملف أكبر من الحد المسموح.");
      const moov = buildMoov(tracks, payloadStart);
      const mdatHead = cat(u32(8 + dataBytes), ascii("mdat"));
      return new Blob([ftyp, moov, mdatHead].concat(payloads), { type: "video/mp4" });
    }

    return { addVideo, addAudio, flush, finish, bytes: () => ftyp.length + dataBytes };
  }

  // ---------- فهرس MP3 (تقطيع على حدود الإطارات) ----------
  const MP3_BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const MP3_BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const MP3_WINDOW = 1 << 20;
  const MP3_PROBE_BYTES = 65536;

  // يقرأ رأس إطار MPEG Layer III عند الموضع p. يرجّع null إذا لم يكن رأساً صالحاً.
  function parseMp3Header(b, p) {
    if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
    const ver = (b[p + 1] >> 3) & 3;
    const layer = (b[p + 1] >> 1) & 3;
    if (ver === 1 || layer !== 1) return null;
    const bri = b[p + 2] >> 4;
    const sri = (b[p + 2] >> 2) & 3;
    if (bri === 0 || bri === 15 || sri === 3) return null;
    const pad = (b[p + 2] >> 1) & 1;
    const mpeg1 = ver === 3;
    const bitrate = (mpeg1 ? MP3_BR_V1[bri] : MP3_BR_V2[bri]) * 1000;
    const sr = MP3_SR[ver][sri];
    const spf = mpeg1 ? 1152 : 576;
    const len = Math.floor(((spf / 8) * bitrate) / sr) + pad;
    return { len, sr, spf, channels: (b[p + 3] >> 6) === 3 ? 1 : 2 };
  }

  // إطار Xing/Info (ترويسة VBR) ما فيه صوت، فنتجاهله
  function isXing(b, p) {
    for (let k = 13; k <= 40 && p + k + 4 <= b.length; k++) {
      const a = b[p + k], c = b[p + k + 1], d = b[p + k + 2], e = b[p + k + 3];
      if ((a === 0x58 && c === 0x69 && d === 0x6e && e === 0x67) ||
          (a === 0x49 && c === 0x6e && d === 0x66 && e === 0x6f)) return true;
    }
    return false;
  }

  const indexCache = new WeakMap();

  /*
   * يبني فهرس إطارات الملف: مواضع البايتات وأطوالها. يقرأ الملف على دفعات (1 ميغا)
   * فلا يحمّل ملف ساعتين كاملاً. يرجّع null إذا لم يكن الملف MP3.
   */
  async function indexMp3(blob) {
    if (indexCache.has(blob)) return indexCache.get(blob);
    const size = blob.size;
    let pos = 0;
    const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const s = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
      pos = 10 + s + (head[5] & 0x10 ? 10 : 0);
    }
    const offs = [];
    const lens = [];
    let sr = 0;
    let spf = 0;
    let first = true;
    scan: while (pos + 4 <= size) {
      const win = new Uint8Array(await blob.slice(pos, Math.min(size, pos + MP3_WINDOW)).arrayBuffer());
      let p = 0;
      while (p + 4 <= win.length) {
        const h = parseMp3Header(win, p);
        if (!h) {
          if (first && pos + p > MP3_PROBE_BYTES) break scan;
          p++;
          continue;
        }
        if (p + h.len > win.length && pos + p + h.len < size) break; // نحتاج الجزء التالي من الملف
        if (first) {
          // نتأكد أن الإطار التالي صالح أيضاً، حتى لا نخلط بين بايتات صدفة وملف MP3 حقيقي
          const nextOk = p + h.len + 4 <= win.length ? !!parseMp3Header(win, p + h.len) : true;
          if (!nextOk) {
            p++;
            continue;
          }
          sr = h.sr;
          spf = h.spf;
          first = false;
          if (isXing(win, p)) {
            p += h.len;
            continue;
          }
        }
        offs.push(pos + p);
        lens.push(h.len);
        p += h.len;
      }
      pos += p;
    }
    const result = offs.length
      ? { sr, spf, count: offs.length, offs: Float64Array.from(offs), lens: Uint16Array.from(lens) }
      : null;
    indexCache.set(blob, result);
    return result;
  }

  // يقطع الملف على حدود إطارات تغطي [startSec, endSec]. startSec الناتج زمن أول إطار في الجزء.
  function mp3Slice(blob, index, startSec, endSec) {
    const { sr, spf, count, offs, lens } = index;
    const j0 = Math.min(count - 1, Math.max(0, Math.floor((startSec * sr) / spf)));
    const j1 = Math.min(count - 1, Math.max(j0, Math.ceil((endSec * sr) / spf)));
    return {
      blob: blob.slice(offs[j0], offs[j1] + lens[j1], "audio/mpeg"),
      startSec: (j0 * spf) / sr,
    };
  }

  const api = {
    VIDEO_TIMESCALE,
    AAC_FRAME,
    createMp4Writer,
    parseMp3Header,
    indexMp3,
    mp3Slice,
  };

  root.InabaMp4 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
