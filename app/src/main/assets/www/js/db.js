/*
 * تخزين محلي بـ IndexedDB:
 * - projects: المسودات (الإعدادات والتوقيت والنصوص المختارة، بدون الملفات الكبيرة).
 * - media:    ملفات المسودة (صور وفيديوهات وصوت مرفوع)، مربوطة برقم المسودة.
 * - cache:    بيانات قابلة لإعادة الاستخدام (نص القرآن، التفسير، الترجمة، قائمة القراء).
 * المسودات محفوظة على هذا المتصفح/الجهاز فقط، ولا تتزامن بين الأجهزة.
 */
(function (root) {
  "use strict";

  const DB_NAME = "inaba-clips";
  const DB_VERSION = 1;
  const MAX_DRAFTS = 30;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!root.indexedDB) {
          reject(new Error("متصفحك لا يدعم التخزين المحلي (IndexedDB)."));
          return;
        }
        const req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
          if (!db.objectStoreNames.contains("media")) {
            const media = db.createObjectStore("media", { keyPath: "key" });
            media.createIndex("projectId", "projectId", { unique: false });
          }
          if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("تعذر فتح التخزين المحلي."));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  // رسالة مفهومة للمستخدم بدل أخطاء المتصفح الإنجليزية، خاصة لما تمتلئ المساحة
  function friendlyError(err, fallback) {
    const msg = String((err && err.message) || "");
    if ((err && err.name === "QuotaExceededError") || /quota/i.test(msg)) {
      return new Error("مساحة التخزين على الجهاز ممتلئة. احذف مسودات أو امسح الكاش من الإعدادات، ثم أعد المحاولة.");
    }
    if (err instanceof Error) return err;
    return new Error(fallback || "فشلت عملية التخزين.");
  }

  const req2p = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // تنفيذ عمليات في معاملة واحدة. fn تستقبل المعاملة وتُرجع قيمة (أو Promise)
  async function tx(names, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      let value;
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(friendlyError(t.error, "فشلت عملية التخزين."));
      t.onabort = () => reject(friendlyError(t.error, "أُلغيت عملية التخزين."));
      Promise.resolve()
        .then(() => fn(t))
        .then((v) => { value = v; }, (err) => {
          try { t.abort(); } catch (_) { /* المعاملة منتهية أصلاً */ }
          reject(friendlyError(err));
        });
    });
  }

  // ---------- الكاش ----------
  async function cacheGet(key) {
    const row = await tx(["cache"], "readonly", (t) => req2p(t.objectStore("cache").get(key)));
    return row ? row.value : null;
  }

  async function cachePut(key, value) {
    await tx(["cache"], "readwrite", (t) => req2p(t.objectStore("cache").put({ key, value, savedAt: Date.now() })));
  }

  async function cacheDelete(key) {
    await tx(["cache"], "readwrite", (t) => req2p(t.objectStore("cache").delete(key)));
  }

  // يحذف كل مفاتيح الكاش التي تحقق match(key). المسودات والملفات لا تتأثر.
  async function cacheClear(match) {
    return tx(["cache"], "readwrite", async (t) => {
      const store = t.objectStore("cache");
      const keys = await req2p(store.getAllKeys());
      (keys || []).filter((k) => match(String(k))).forEach((k) => store.delete(k));
      return true;
    });
  }

  // ---------- المسودات ----------
  async function listProjects() {
    const rows = await tx(["projects"], "readonly", (t) => req2p(t.objectStore("projects").getAll()));
    return (rows || []).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function countProjects() {
    return tx(["projects"], "readonly", (t) => req2p(t.objectStore("projects").count()));
  }

  async function getProject(id) {
    return tx(["projects", "media"], "readonly", async (t) => {
      const project = await req2p(t.objectStore("projects").get(id));
      if (!project) throw new Error("المسودة غير موجودة.");
      const media = await req2p(t.objectStore("media").index("projectId").getAll(IDBKeyRange.only(id)));
      return { project, media: media || [] };
    });
  }

  // rec: {id, name, createdAt, updatedAt, summary, state}
  // media: [{refId, role, name, type, blob}]
  async function saveProject(rec, media) {
    return tx(["projects", "media"], "readwrite", async (t) => {
      const projects = t.objectStore("projects");
      const existing = await req2p(projects.get(rec.id));
      if (!existing) {
        const count = await req2p(projects.count());
        if (count >= MAX_DRAFTS) {
          throw new Error(`وصلت للحد الأقصى (${MAX_DRAFTS} مسودة). احذف مسودة قبل حفظ مسودة جديدة.`);
        }
      }
      projects.put(rec);
      const store = t.objectStore("media");
      const old = await req2p(store.index("projectId").getAllKeys(IDBKeyRange.only(rec.id)));
      (old || []).forEach((key) => store.delete(key));
      for (const m of media) {
        store.put({ key: `${rec.id}|${m.refId}`, projectId: rec.id, refId: m.refId, role: m.role, name: m.name, type: m.type, blob: m.blob });
      }
      return true;
    });
  }

  async function renameProject(id, name) {
    return tx(["projects"], "readwrite", async (t) => {
      const store = t.objectStore("projects");
      const rec = await req2p(store.get(id));
      if (!rec) throw new Error("المسودة غير موجودة.");
      rec.name = name;
      rec.updatedAt = Date.now();
      store.put(rec);
      return true;
    });
  }

  async function deleteProject(id) {
    return tx(["projects", "media"], "readwrite", async (t) => {
      t.objectStore("projects").delete(id);
      const store = t.objectStore("media");
      const keys = await req2p(store.index("projectId").getAllKeys(IDBKeyRange.only(id)));
      (keys || []).forEach((key) => store.delete(key));
      return true;
    });
  }

  root.InabaDB = {
    MAX_DRAFTS,
    cacheGet,
    cachePut,
    cacheDelete,
    cacheClear,
    friendlyError,
    listProjects,
    countProjects,
    getProject,
    saveProject,
    renameProject,
    deleteProject,
  };
})(typeof window !== "undefined" ? window : globalThis);
