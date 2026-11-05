const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// localStorage بسيط للاختبار في Node
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
require("../app/src/main/assets/www/js/store.js");
const ST = globalThis.InabaStore;

beforeEach(() => mem.clear());

test("prefs return defaults and merge saved values", () => {
  const p = ST.prefs.get();
  assert.equal(p.theme, "dark");
  assert.equal(p.cacheAudio, false);
  assert.equal(p.defaults.res, 1080);

  ST.prefs.set({ theme: "light", defaults: { aspect: "16:9", res: 2160, lightMode: false } });
  const q = ST.prefs.get();
  assert.equal(q.theme, "light");
  assert.equal(q.defaults.res, 2160);
  assert.equal(q.cacheAudio, false);
});

test("favorites toggle per kind and compare ids as strings", () => {
  assert.equal(ST.favorites.toggle("bg", "mtn-1"), true);
  assert.equal(ST.favorites.has("bg", "mtn-1"), true);
  assert.equal(ST.favorites.has("reciters", 1), false);
  assert.equal(ST.favorites.toggle("reciters", 7), true);
  assert.equal(ST.favorites.has("reciters", "7"), true);
  assert.equal(ST.favorites.toggle("bg", "mtn-1"), false);
  assert.deepEqual(ST.favorites.list("bg"), []);
});

test("recent backgrounds dedupe, move to front, and cap at 8", () => {
  for (let i = 0; i < 10; i++) ST.recent.push(`id-${i}`);
  ST.recent.push("id-5");
  const list = ST.recent.list();
  assert.equal(list.length, 8);
  assert.equal(list[0], "id-5");
  assert.equal(new Set(list).size, 8);
});

test("history keeps newest first and caps at 50", () => {
  for (let i = 0; i < 60; i++) ST.history.add("export", `v${i}`);
  const list = ST.history.list();
  assert.equal(list.length, ST.HISTORY_MAX);
  assert.equal(list[0].label, "v59");
  ST.history.clear();
  assert.deepEqual(ST.history.list(), []);
});

test("corrupt stored JSON falls back to defaults instead of throwing", () => {
  mem.set("inaba.prefs.v1", "{not json");
  mem.set("inaba.favorites.v1", "[]");
  assert.equal(ST.prefs.get().theme, "dark");
  assert.deepEqual(ST.favorites.all(), { bg: [], reciters: [] });
});
