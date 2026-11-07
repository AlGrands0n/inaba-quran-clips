/*
 * تفضيلات المستخدم والمفضلة وآخر ما استُخدم وسجل النشاط.
 * كلها على الجهاز فقط (localStorage). ما فيها أي بيانات حساسة أو معرّفات حساب.
 */
(function (root) {
  "use strict";

  const KEYS = {
    prefs: "inaba.prefs.v1",
    favorites: "inaba.favorites.v1",
    recent: "inaba.recentBg.v1",
    history: "inaba.history.v1",
  };
  const HISTORY_MAX = 50;
  const RECENT_MAX = 8;

  function read(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false; // التخزين ممتلئ أو معطّل
    }
  }

  const DEFAULT_PREFS = {
    theme: "dark",
    cacheAudio: false,
    defaults: { aspect: "9:16", res: 1080, lightMode: false },
  };

  const prefs = {
    get() {
      const saved = read(KEYS.prefs, {});
      return { ...DEFAULT_PREFS, ...saved, defaults: { ...DEFAULT_PREFS.defaults, ...(saved.defaults || {}) } };
    },
    set(patch) {
      const next = { ...this.get(), ...patch };
      write(KEYS.prefs, next);
      return next;
    },
  };

  // kind: "bg" (خلفيات المكتبة بالمعرّف) أو "reciters" (معرّف القارئ)
  const favorites = {
    all() {
      const f = read(KEYS.favorites, {});
      return { bg: Array.isArray(f.bg) ? f.bg : [], reciters: Array.isArray(f.reciters) ? f.reciters : [] };
    },
    list(kind) {
      return this.all()[kind];
    },
    has(kind, id) {
      return this.list(kind).includes(String(id));
    },
    toggle(kind, id) {
      const f = this.all();
      const key = String(id);
      f[kind] = f[kind].includes(key) ? f[kind].filter((x) => x !== key) : [...f[kind], key];
      write(KEYS.favorites, f);
      return f[kind].includes(key);
    },
  };

  const recent = {
    list() {
      return read(KEYS.recent, []);
    },
    push(id) {
      const next = [String(id), ...this.list().filter((x) => x !== String(id))].slice(0, RECENT_MAX);
      write(KEYS.recent, next);
    },
  };

  const history = {
    list() {
      return read(KEYS.history, []);
    },
    add(type, label) {
      const next = [{ t: Date.now(), type, label }, ...this.list()].slice(0, HISTORY_MAX);
      write(KEYS.history, next);
    },
    clear() {
      write(KEYS.history, []);
    },
  };

  root.InabaStore = { prefs, favorites, recent, history, HISTORY_MAX };
})(typeof window !== "undefined" ? window : globalThis);
