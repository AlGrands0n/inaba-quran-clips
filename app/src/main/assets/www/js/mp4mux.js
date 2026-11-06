/*
 * كاتب MP4 (fragmented MP4) وفهرس ملفات MP3. دوال نقية بدون متصفح، فتُختبر في Node.
 *
 * - الفيديو: H.264 بصيغة AVCC (كما يخرجها VideoEncoder مع avc.format = "avc").
 * - الصوت: AAC-LC خام (كما يخرجها AudioEncoder)، مع AudioSpecificConfig من الـ metadata.
 * - الملف: صندوق ftyp + moov (بدون جداول عينات) ثم أجزاء moof + mdat.
 *   الكتابة تدريجية، ولا نحتاج معرفة الحجم الكلي قبل البدء.
 */
(function (root) {
  "use strict";

  const VIDEO_TIMESCALE = 90000; // يقبل القسمة على 24 و25 و30 و60 بدون كسور
  const AAC_FRAME = 1024;

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
  const i32 = (n) => {
    const d = new DataView(new ArrayBuffer(4));
    d.setInt32(0, n);
    return new Uint8Array(d.buffer);
  };
  const u64 = (n) => cat(u32(Math.floor(n / 4294967296)), u32(n % 4294967296));

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

  // ---------- وصف العينات (sample entries) والجداول الفارغة ----------
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

  const emptyStbl = (entry) =>
    box(
      "stbl",
      fbox("stsd", 0, 0, u32(1), entry),
      fbox("stts", 0, 0, u32(0)),
      fbox("stsc", 0, 0, u32(0)),
      fbox("stsz", 0, 0, u32(0), u32(0)),
      fbox("stco", 0, 0, u32(0)),
    );

  function trak(o) {
    const w = o.isVideo ? o.width : 0;
    const h = o.isVideo ? o.height : 0;
    const tkhd = fbox(
      "tkhd", 0, 3,
      u32(0), u32(0), u32(o.trackId), u32(0), u32(0),
      zeros(8), u16(0), u16(0), u16(o.isVideo ? 0 : 0x0100), u16(0),
      MATRIX, u32(w * 65536), u32(h * 65536),
    );
    const mdhd = fbox("mdhd", 0, 0, u32(0), u32(0), u32(o.timescale), u32(0), u16(0x55c4), u16(0));
    const hdlr = fbox(
      "hdlr", 0, 0,
      u32(0), ascii(o.handler), zeros(12),
      ascii(o.isVideo ? "VideoHandler" : "SoundHandler"), u8(0),
    );
    const dinf = box("dinf", fbox("dref", 0, 0, u32(1), fbox("url ", 0, 1)));
    const minf = box("minf", o.mediaHeader, dinf, emptyStbl(o.entry));
    return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  }

  const mvhd = (durationMs, nextTrack) =>
    fbox(
      "mvhd", 0, 0,
      u32(0), u32(0), u32(1000), u32(durationMs),
      u32(0x10000), u16(0x100), u16(0), zeros(8),
      MATRIX, zeros(24), u32(nextTrack),
    );

  const trex = (trackId) => fbox("trex", 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));

  function initSegment(cfg) {
    const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
    const tracks = [
      trak({
        trackId: 1, isVideo: true, width: cfg.width, height: cfg.height,
        timescale: VIDEO_TIMESCALE, handler: "vide",
        mediaHeader: fbox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
        entry: sampleEntryAvc(cfg.width, cfg.height, cfg.avcC),
      }),
    ];
    const ids = [1];
    if (cfg.audio) {
      tracks.push(trak({
        trackId: 2, isVideo: false, timescale: cfg.audio.sampleRate, handler: "soun",
        mediaHeader: fbox("smhd", 0, 0, u16(0), u16(0)),
        entry: sampleEntryAac(cfg.audio.channels, cfg.audio.sampleRate, cfg.audio.asc),
      }));
      ids.push(2);
    }
    const moov = box("moov", mvhd(cfg.durationMs, ids.length + 1), ...tracks, box("mvex", ...ids.map(trex)));
    return cat(ftyp, moov);
  }

  // ---------- كاتب الأجزاء ----------
  /*
   * cfg: {width, height, avcC (Uint8Array), durationMs, audio: {sampleRate, channels, asc} | null}
   * addVideo(data, dts, dur, key)  — dts و dur بوحدة 90000 في الثانية
   * addAudio(data, dts, dur)       — dts و dur بوحدة معدل العينة
   * flush(untilSec)                — يكتب العينات التي زمنها < untilSec في جزء واحد
   * finish()                       — يكتب كل ما تبقى ويرجّع Blob
   */
  function createMp4Writer(cfg) {
    const parts = [];
    const vq = [];
    const aq = [];
    let seq = 1;
    let bytesOut = 0;
    const hasAudio = !!cfg.audio;

    const init = initSegment(cfg);
    parts.push(init);
    bytesOut += init.length;

    function addVideo(data, dts, dur, key) {
      vq.push({ data, dts, dur, flags: key ? 0x02000000 : 0x01010000 });
    }

    function addAudio(data, dts, dur) {
      aq.push({ data, dts, dur, flags: 0x02000000 });
    }

    function takeBefore(q, limit) {
      let n = 0;
      while (n < q.length && q[n].dts < limit) n++;
      return q.splice(0, n);
    }

    const sizeOf = (samples) => samples.reduce((n, s) => n + s.data.length, 0);

    function emit(runs) {
      const dataLen = runs.reduce((n, r) => n + sizeOf(r.samples), 0);
      const buildMoof = (offsets) =>
        box(
          "moof",
          fbox("mfhd", 0, 0, u32(seq)),
          ...runs.map((r, i) => {
            const entries = r.samples.map((s) => cat(u32(s.dur), u32(s.data.length), u32(s.flags)));
            return box(
              "traf",
              fbox("tfhd", 0, 0x020000, u32(r.trackId)),
              fbox("tfdt", 1, 0, u64(r.base)),
              fbox("trun", 0, 0x000701, u32(r.samples.length), i32(offsets[i]), ...entries),
            );
          }),
        );

      // حجم الـ moof ثابت (كل الحقول بحجم ثابت)، فنحسبه أولاً ثم نضع إزاحات البيانات
      const probe = buildMoof(runs.map(() => 0));
      let off = probe.length + 8; // +8 لرأس mdat
      const offsets = runs.map((r) => {
        const at = off;
        off += sizeOf(r.samples);
        return at;
      });
      const moof = buildMoof(offsets);
      const mdatHead = cat(u32(8 + dataLen), ascii("mdat"));
      parts.push(moof, mdatHead);
      bytesOut += moof.length + mdatHead.length;
      for (const r of runs) {
        for (const s of r.samples) {
          parts.push(s.data);
          bytesOut += s.data.length;
        }
      }
      seq++;
    }

    function flush(untilSec) {
      const v = takeBefore(vq, untilSec * VIDEO_TIMESCALE);
      const a = hasAudio ? takeBefore(aq, untilSec * cfg.audio.sampleRate) : [];
      if (!v.length && !a.length) return;
      const runs = [];
      if (v.length) runs.push({ trackId: 1, base: v[0].dts, samples: v });
      if (a.length) runs.push({ trackId: 2, base: a[0].dts, samples: a });
      emit(runs);
    }

    function finish() {
      flush(Infinity);
      return new Blob(parts, { type: "video/mp4" });
    }

    return { addVideo, addAudio, flush, finish, bytes: () => bytesOut };
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
