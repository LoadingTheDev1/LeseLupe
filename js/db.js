// Small promise wrapper around IndexedDB. Everything the app keeps lives here, on the reader's own device.
const DB_NAME = "leselupe";
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("content")) db.createObjectStore("content", { keyPath: "id" });
      if (!db.objectStoreNames.contains("words")) {
        const s = db.createObjectStore("words", { keyPath: "id" });
        s.createIndex("bookId", "bookId");
        s.createIndex("list", "list");
      }
      if (!db.objectStoreNames.contains("lists")) db.createObjectStore("lists", { keyPath: "name" });
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "k" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function asPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

export async function get(store, key) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).get(key));
}
export async function getAll(store) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).getAll());
}
export async function getAllByIndex(store, index, value) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).index(index).getAll(value));
}
export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  return finished(tx);
}
export async function putMany(store, values) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  values.forEach((v) => s.put(v));
  return finished(tx);
}
export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  return finished(tx);
}
export async function clear(store) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  return finished(tx);
}

// key/value helpers
export async function kvGet(k, fallback = null) {
  const row = await get("kv", k);
  return row ? row.v : fallback;
}
export function kvSet(k, v) {
  return put("kv", { k, v });
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
