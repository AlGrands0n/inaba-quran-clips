const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const M = require("../app/src/main/assets/www/js/mp4mux.js");

function hasTool(name) {
  try {
    execFileSync(name, ["-version"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}
const HAS_FFMPEG = hasTool("ffmpeg") && hasTool("ffprobe");
const skip = HAS_FFMPEG ? false : "ffmpeg/ffprobe غير متوفر";

// ---------- مساعدات تحويل مخرجات ffmpeg إلى عينات ----------

// يقسم Annex B إلى وحدات NAL
function splitAnnexB(buf) {
  const starts = [];
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) starts.push(i);
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let begin = starts[k] + 3;
    // نحذف صفر البداية الرباعية (00 00 00 01)
    if (end > begin && buf[end - 1] === 0) end--;
    nals.push(buf.subarray(begin, end));
  }
  return nals;
}

// يجمع الوحدات في وحدات وصول (access units). وحدة جديدة تبدأ عند AUD أو SEI أو SPS/PPS،
// أو عند شريحة أولى (first_mb_in_slice = 0 أي أول بت بعد الترويسة = 1). ffmpeg لا يكتب AUD دائماً.
function toAccessUnits(nals) {
  const aus = [];
  let cur = [];
  let hasSlice = false;
  for (const n of nals) {
    const type = n[0] & 31;
    const firstSlice = (type === 1 || type === 5) && (n[1] & 0x80) !== 0;
    if ([6, 7, 8, 9].includes(type) || firstSlice) {
      if (hasSlice) {
        aus.push(cur);
        cur = [];
        hasSlice = false;
      }
    }
    if (type === 1 || type === 5) hasSlice = true;
    if (type !== 9) cur.push(n);
  }
  if (hasSlice) aus.push(cur);
  return aus;
}

function avcCFromSps(sps, pps) {
  return Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([(sps.length >> 8) & 255, sps.length & 255]), Buffer.from(sps),
    Buffer.from([1]),
    Buffer.from([(pps.length >> 8) & 255, pps.length & 255]), Buffer.from(pps),
  ]);
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// يقرأ إطارات ADTS ويعيد الإطارات الخام مع AudioSpecificConfig
function parseAdts(buf) {
  const frames = [];
  let asc = null;
  let sr = 0;
  let ch = 0;
  let p = 0;
  while (p + 7 <= buf.length) {
    if (buf[p] !== 0xff || (buf[p + 1] & 0xf0) !== 0xf0) break;
    const protectionAbsent = buf[p + 1] & 1;
    const profile = ((buf[p + 2] >> 6) & 3) + 1;
    const sfIdx = (buf[p + 2] >> 2) & 15;
    const chCfg = ((buf[p + 2] & 1) << 2) | (buf[p + 3] >> 6);
    const len = ((buf[p + 3] & 3) << 11) | (buf[p + 4] << 3) | (buf[p + 5] >> 5);
    const hdr = protectionAbsent ? 7 : 9;
    if (!asc) {
      asc = Buffer.from([(profile << 3) | (sfIdx >> 1), ((sfIdx & 1) << 7) | (chCfg << 3)]);
      sr = AAC_RATES[sfIdx];
      ch = chCfg;
    }
    frames.push(buf.subarray(p + hdr, p + len));
    p += len;
  }
  return { frames, asc, sampleRate: sr, channels: ch };
}

function makeSources(dir) {
  const h264 = path.join(dir, "v.h264");
  const aac = path.join(dir, "a.aac");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
    "-t", "1", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-x264-params", "bframes=0:keyint=15", "-f", "h264", h264,
  ]);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1",
    "-c:a", "aac", "-b:a", "128k", "-f", "adts", aac,
  ]);
  return { h264: fs.readFileSync(h264), aac: fs.readFileSync(aac) };
}

test("parseMp3Header reads MPEG1 Layer III 128k 44.1k", () => {
  const h = M.parseMp3Header(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), 0);
  assert.deepEqual(h, { len: 417, sr: 44100, spf: 1152, channels: 2 });
});

test("parseMp3Header rejects non-audio bytes", () => {
  assert.equal(M.parseMp3Header(Uint8Array.from([0x00, 0x00, 0x00, 0x00]), 0), null);
  // طبقة II (ليست III)
  assert.equal(M.parseMp3Header(Uint8Array.from([0xff, 0xfd, 0x90, 0x00]), 0), null);
});

test("mp4 writer output is accepted by ffprobe and decodes without errors", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp4mux-"));
  const { h264, aac } = makeSources(dir);

  const nals = splitAnnexB(h264);
  const aus = toAccessUnits(nals);
  assert.equal(aus.length, 30, "ثانية واحدة بـ 30 إطاراً");
  const sps = nals.find((n) => (n[0] & 31) === 7);
  const pps = nals.find((n) => (n[0] & 31) === 8);
  assert.ok(sps && pps, "SPS/PPS موجودان في الستريم");

  const adts = parseAdts(aac);
  assert.ok(adts.frames.length > 40, "إطارات AAC كافية");

  const writer = M.createMp4Writer({
    width: 320,
    height: 240,
    avcC: new Uint8Array(avcCFromSps(sps, pps)),
    durationMs: 1000,
    audio: { sampleRate: adts.sampleRate, channels: adts.channels, asc: new Uint8Array(adts.asc) },
  });

  const vTicks = M.VIDEO_TIMESCALE / 30;
  let videoBytes = 0;
  aus.forEach((au, i) => {
    const parts = au
      .filter((n) => ![7, 8].includes(n[0] & 31))
      .map((n) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(n.length);
        return Buffer.concat([len, Buffer.from(n)]);
      });
    const data = new Uint8Array(Buffer.concat(parts));
    const key = au.some((n) => (n[0] & 31) === 5);
    videoBytes += data.length;
    writer.addVideo(data, i * vTicks, vTicks, key);
    if (i === 14) writer.flush((i + 1) / 30); // جزء وسط الملف
  });

  adts.frames.forEach((f, j) => writer.addAudio(new Uint8Array(f), j * M.AAC_FRAME, M.AAC_FRAME));

  const blob = writer.finish();
  const out = path.join(dir, "out.mp4");
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  assert.ok(blob.size > videoBytes, "الملف يحتوي البيانات");

  const probe = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_packets",
    "-count_packets", "-of", "json", out,
  ]).toString();
  const info = JSON.parse(probe);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  assert.equal(v.codec_name, "h264");
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
  assert.equal(Number(v.nb_read_packets), aus.length);
  assert.equal(a.codec_name, "aac");
  assert.equal(Number(a.nb_read_packets), adts.frames.length);

  // فك كامل: أي خطأ في الصناديق أو العينات يظهر في stderr
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(dec.status, 0);
  assert.equal(dec.stderr.trim(), "", "لا أخطاء فك");
});

test("mp3 index finds frames and slices on frame boundaries", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp3idx-"));
  const mp3 = path.join(dir, "t.mp3");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=1000:d=10",
    "-c:a", "libmp3lame", "-b:a", "128k", mp3,
  ]);
  const blob = new Blob([fs.readFileSync(mp3)], { type: "audio/mpeg" });
  const idx = await M.indexMp3(blob);
  assert.ok(idx, "الملف MP3 معروف");
  assert.equal(idx.sr, 44100);
  const expected = (10 * 44100) / 1152;
  assert.ok(Math.abs(idx.count - expected) < 3, `عدد الإطارات ${idx.count} قريب من ${expected.toFixed(1)}`);

  const cut = M.mp3Slice(blob, idx, 2.0, 4.0);
  assert.ok(cut.startSec <= 2.0 && cut.startSec > 2.0 - 1152 / 44100 - 1e-9, "البداية على حد إطار قبل 2 ثانية");
  assert.ok(cut.blob.size > 0 && cut.blob.size < blob.size / 2, "القطعة أصغر من الملف");
});

test("indexMp3 returns null for non-mp3 data", async () => {
  const blob = new Blob([new Uint8Array(200000)], { type: "audio/wav" });
  assert.equal(await M.indexMp3(blob), null);
});
