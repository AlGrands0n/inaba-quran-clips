/*
 * التصدير السريع: يرسم الإطارات بسرعة المعالج (بدون انتظار الوقت الحقيقي للمقطع)،
 * ويشفّرها H.264 والصوت AAC عبر WebCodecs، ويكتب الملف عبر InabaMp4.
 *
 * يحتاج متصفحاً يدعم VideoEncoder و AudioEncoder (Chrome على أندرويد يدعمهما).
 * إذا ما توفّر أي شيء منهم، التطبيق يرجع للتسجيل المباشر (MediaRecorder).
 */
(function (root) {
  "use strict";

  const MP4 = root.InabaMp4 || (typeof require === "function" ? require("./mp4mux.js") : null);
  const SAMPLE_RATE = 48000;
  const FRAGMENT_SECONDS = 1;
  const PREROLL_SEC = 1;
  const MAX_DECODED_BYTES = 350 * 1024 * 1024;

  const yieldNow = () =>
    new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    });

  const abortError = () => {
    const e = new Error("تم إلغاء التصدير.");
    e.name = "AbortError";
    return e;
  };

  const bytesOf = (d) => (d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));

  // مستويات H.264 حسب عدد ماكروبلوكات الإطار (16×16)
  function codecCandidates(width, height) {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    if (mbs <= 8192) return ["avc1.640028", "avc1.42E01F"];
    if (mbs <= 22080) return ["avc1.640032", "avc1.640028"];
    return ["avc1.640033", "avc1.640032"];
  }

  // يتحقق أن الجهاز يقدر يشفّر H.264 وAAC. ما يرجع خطأ، فقط ok=false مع السبب.
  async function probe(width, height) {
    const out = { ok: false, videoCodec: "", reason: "" };
    const OfflineCtx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!root.VideoEncoder || !root.AudioEncoder || !root.VideoFrame || !root.AudioData || !OfflineCtx || !MP4) {
      out.reason = "المتصفح لا يدعم التصدير السريع (WebCodecs).";
      return out;
    }
    if (width % 2 || height % 2) {
      out.reason = "الأبعاد يجب أن تكون زوجية.";
      return out;
    }
    for (const codec of codecCandidates(width, height)) {
      try {
        const r = await root.VideoEncoder.isConfigSupported({
          codec, width, height, bitrate: 4e6, framerate: 30, latencyMode: "realtime", avc: { format: "avc" },
        });
        if (r.supported) {
          out.videoCodec = codec;
          break;
        }
      } catch (_) {
        /* نجرّب المستوى التالي */
      }
    }
    if (!out.videoCodec) {
      out.reason = "ترميز H.264 غير متوفر على هذا الجهاز.";
      return out;
    }
    try {
      const r = await root.AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2", sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 160000,
      });
      if (!r.supported) {
        out.reason = "ترميز AAC غير متوفر على هذا الجهاز.";
        return out;
      }
    } catch (_) {
      out.reason = "ترميز AAC غير متوفر على هذا الجهاز.";
      return out;
    }
    out.ok = true;
    return out;
  }

  /*
   * يفك الصوت لمدة معينة فقط، بمقدار 48 كيلوهيرتز ستيريو.
   * MP3: يقطع الملف على حدود الإطارات ويفك القطعة فقط.
   * غير ذلك: يفك الملف كاملاً، ويرفض إذا كان الناتج سيتجاوز الحد.
   */
  async function decodeAudioSegment(blob, startSec, durationSec, opts) {
    const OfflineCtx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const index = await MP4.indexMp3(blob);
    let src = blob;
    let base = 0;
    if (index) {
      const cut = MP4.mp3Slice(blob, index, Math.max(0, startSec - PREROLL_SEC), startSec + durationSec + 0.5);
      src = cut.blob;
      base = cut.startSec;
    } else if ((opts && opts.fullDurationSec ? opts.fullDurationSec : 0) * SAMPLE_RATE * 2 * 4 > MAX_DECODED_BYTES) {
      const e = new Error("ملف الصوت كبير ولا يُفك كاملاً. سيُستخدم التسجيل المباشر.");
      e.code = "TOO_LARGE";
      throw e;
    }
    const ctx = new OfflineCtx(2, 1, SAMPLE_RATE);
    const buf = await ctx.decodeAudioData(await src.arrayBuffer());
    const offset = Math.round((startSec - base) * buf.sampleRate);
    const frames = Math.round(durationSec * buf.sampleRate);
    const channels = [0, 1].map((c) => {
      const data = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const k = offset + i;
        if (k >= 0 && k < data.length) out[i] = data[k];
      }
      return out;
    });
    return { channels, sampleRate: buf.sampleRate, frames };
  }

  /*
   * يرسم ويشفّر المقطع ويرجّع Blob بصيغة MP4.
   * o: {canvas, width, height, fps, startSec, durationSec, bitrate, codec,
   *     audio: {channels, sampleRate, frames} | null,
   *     drawFrame(t), beforeFrame?(t) async, onProgress?(p, elapsedMs), isCancelled?()}
   * t في الدالتين هو زمن الملف الأصلي (startSec + ...)، فيتطابق مع التوقيت.
   */
  async function encodeMp4(o) {
    const { canvas, width, height, fps, startSec, durationSec, bitrate, codec } = o;
    const audio = o.audio || null;
    const sr = audio ? audio.sampleRate : 0;
    const frames = Math.max(1, Math.round(durationSec * fps));
    const frameTicks = MP4.VIDEO_TIMESCALE / fps;
    const frameUs = 1e6 / fps;
    const keyEvery = Math.round(fps * 2);
    const meta = { avcC: null, asc: null };
    const pendV = [];
    const pendA = [];
    let writer = null;
    let failed = null;
    let lastV = -1;
    let vOut = 0;
    let aOut = 0;
    let lastFlush = 0;
    let audioFed = 0;
    const startedAt = performance.now();

    function ensureWriter() {
      if (writer || !meta.avcC || (audio && !meta.asc)) return;
      writer = MP4.createMp4Writer({
        width,
        height,
        avcC: meta.avcC,
        durationMs: Math.round(durationSec * 1000),
        audio: audio ? { sampleRate: sr, channels: 2, asc: meta.asc } : null,
      });
      for (const s of pendV) writer.addVideo(s.data, s.dts, s.dur, s.key);
      for (const s of pendA) writer.addAudio(s.data, s.dts, s.dur);
      pendV.length = 0;
      pendA.length = 0;
    }

    const vEnc = new root.VideoEncoder({
      output: (chunk, m) => {
        const d = m && m.decoderConfig && m.decoderConfig.description;
        if (d && !meta.avcC) meta.avcC = bytesOf(d).slice();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const dts = Math.round((chunk.timestamp * MP4.VIDEO_TIMESCALE) / 1e6);
        // بدون B-frames الترتيب يبقى تصاعدياً. إذا لا، الملف سيكون خاطئاً، فنوقف ونرجع للتسجيل المباشر
        if (dts <= lastV) failed = failed || new Error("ترتيب الإطارات غير متوقع.");
        lastV = dts;
        vOut++;
        const s = { data, dts, dur: frameTicks, key: chunk.type === "key" };
        if (writer) writer.addVideo(s.data, s.dts, s.dur, s.key);
        else pendV.push(s);
        ensureWriter();
      },
      error: (e) => {
        failed = failed || e;
      },
    });
    vEnc.configure({ codec, width, height, bitrate, framerate: fps, latencyMode: "realtime", avc: { format: "avc" } });

    const aEnc = audio
      ? new root.AudioEncoder({
          output: (chunk, m) => {
            const d = m && m.decoderConfig && m.decoderConfig.description;
            if (d && !meta.asc) meta.asc = bytesOf(d).slice();
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            aOut++;
            const dts = (aOut - 1) * MP4.AAC_FRAME;
            if (writer) writer.addAudio(data, dts, MP4.AAC_FRAME);
            else pendA.push({ data, dts, dur: MP4.AAC_FRAME });
            ensureWriter();
          },
          error: (e) => {
            failed = failed || e;
          },
        })
      : null;
    if (aEnc) aEnc.configure({ codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: 2, bitrate: 160000 });

    function feedAudio(untilSample) {
      if (!aEnc) return;
      const end = Math.min(audio.frames, untilSample);
      while (audioFed < end) {
        const n = Math.min(MP4.AAC_FRAME, audio.frames - audioFed, Math.ceil(end) - audioFed);
        const buf = new Float32Array(n * 2);
        buf.set(audio.channels[0].subarray(audioFed, audioFed + n), 0);
        buf.set(audio.channels[1].subarray(audioFed, audioFed + n), n);
        const ad = new root.AudioData({
          format: "f32-planar",
          sampleRate: sr,
          numberOfFrames: n,
          numberOfChannels: 2,
          timestamp: Math.round((audioFed * 1e6) / sr),
          data: buf,
        });
        aEnc.encode(ad);
        ad.close();
        audioFed += n;
      }
    }

    // نكتب فقط العينات التي لن يأتي قبلها شيء من المشفّر
    function maybeFlush() {
      if (!writer) return;
      const v = (vOut * frameTicks) / MP4.VIDEO_TIMESCALE;
      const a = audio ? (aOut * MP4.AAC_FRAME) / sr : Infinity;
      const bound = Math.min(v, a);
      if (bound - lastFlush >= FRAGMENT_SECONDS) {
        writer.flush(bound);
        lastFlush = bound;
      }
    }

    const check = () => {
      if (failed) throw failed;
      if (o.isCancelled && o.isCancelled()) throw abortError();
    };

    try {
      for (let i = 0; i < frames; i++) {
        check();
        const t = startSec + i / fps;
        if (o.beforeFrame) await o.beforeFrame(t);
        o.drawFrame(t);
        const vf = new root.VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
        vEnc.encode(vf, { keyFrame: i % keyEvery === 0 });
        vf.close();
        feedAudio(((i + 1) / fps) * sr);
        maybeFlush();
        // ضغط خلفي: ما نترك المشفّر يتراكم في الذاكرة
        while (vEnc.encodeQueueSize > 4 || (aEnc && aEnc.encodeQueueSize > 16)) {
          check();
          await yieldNow();
        }
        if (o.onProgress && i % 3 === 0) o.onProgress((i + 1) / frames, performance.now() - startedAt);
        if (i % 4 === 3) await yieldNow();
      }
      feedAudio(Infinity);
      await vEnc.flush();
      if (aEnc) await aEnc.flush();
      check();
      ensureWriter();
      if (!writer) throw new Error("تعذّر تهيئة الملف (لم يصل ترميز الفيديو).");
      if (o.onProgress) o.onProgress(1, performance.now() - startedAt);
      return writer.finish();
    } finally {
      try { vEnc.close(); } catch (_) { /* مغلق أصلاً */ }
      if (aEnc) {
        try { aEnc.close(); } catch (_) { /* مغلق أصلاً */ }
      }
    }
  }

  const api = { probe, decodeAudioSegment, encodeMp4, codecCandidates, yieldNow, MAX_DECODED_BYTES };
  root.InabaExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
