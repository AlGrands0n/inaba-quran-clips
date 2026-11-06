const test = require("node:test");
const assert = require("node:assert/strict");

const E = require("../app/src/main/assets/www/js/exporter.js");

test("codecCandidates picks H.264 level by macroblock count", () => {
  // 1080x1920 = 8160 ماكروبلوك: يكفيه المستوى 4.0
  assert.deepEqual(E.codecCandidates(1080, 1920), ["avc1.640028", "avc1.42E01F"]);
  // 1440x2560 = 14400 ماكروبلوك: يحتاج 5.0
  assert.deepEqual(E.codecCandidates(1440, 2560), ["avc1.640032", "avc1.640028"]);
  // 2160x3840 = 32400 ماكروبلوك: يحتاج 5.1
  assert.deepEqual(E.codecCandidates(2160, 3840), ["avc1.640033", "avc1.640032"]);
});
