const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const L = require("../app/src/main/assets/www/js/library.js");

const good = {
  id: "mtn-1",
  title: "جبل",
  category: "mountains",
  type: "image",
  file: "mountains/mtn-1.jpg",
  license: "CC0 https://creativecommons.org/publicdomain/zero/1.0/",
  source: "https://example.org/1",
  author: "أحد",
};

test("accepts a complete item and builds its URL", () => {
  const r = L.validateManifest({ items: [good] });
  assert.equal(r.items.length, 1);
  assert.equal(r.errors.length, 0);
  assert.equal(L.itemUrl(r.items[0]), "backgrounds/mountains/mtn-1.jpg");
});

test("rejects items missing license, source or author", () => {
  const r = L.validateManifest({
    items: [
      { ...good, id: "a", license: "" },
      { ...good, id: "b", source: undefined },
      { ...good, id: "c", author: "" },
    ],
  });
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.errors.map((e) => e.id), ["a", "b", "c"]);
  assert.ok(r.errors.every((e) => e.problems.includes("license")));
});

test("rejects unknown category and unknown type", () => {
  const r = L.validateManifest({
    items: [
      { ...good, id: "x", category: "cars" },
      { ...good, id: "y", type: "audio" },
    ],
  });
  assert.equal(r.items.length, 0);
  assert.ok(r.errors[0].problems.includes("category"));
  assert.ok(r.errors[1].problems.includes("type"));
});

test("rejects unsafe file paths", () => {
  const r = L.validateManifest({
    items: [
      { ...good, id: "p1", file: "/etc/passwd" },
      { ...good, id: "p2", file: "../secret.jpg" },
      { ...good, id: "p3", file: "" },
    ],
  });
  assert.equal(r.items.length, 0);
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors.every((e) => e.problems.includes("file")));
});

test("keeps the first of duplicate ids and rejects the rest", () => {
  const r = L.validateManifest({ items: [good, { ...good, title: "نسخة" }] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, "جبل");
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].problems.includes("id"));
});

test("non-array input yields an empty, error-free result", () => {
  assert.deepEqual(L.validateManifest(null), { items: [], errors: [] });
  assert.deepEqual(L.validateManifest({ items: "nope" }), { items: [], errors: [] });
});

test("the committed backgrounds/manifest.json validates with no errors", () => {
  const file = path.join(__dirname, "../app/src/main/assets/www/backgrounds/manifest.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = L.validateManifest(data);
  assert.deepEqual(r.errors, [], "every item in the committed manifest must be complete");
});
