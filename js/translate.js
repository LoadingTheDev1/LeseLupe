// Free translation sources, tried in order:
//  1. Chrome's built-in on-device translator (no limit, no network) when the browser has it
//  2. MyMemory (free online service, daily character limit)
// Word meanings and base forms come from Wiktionary (free, CC BY-SA).
// Every result is cached on the device, so tapping the same thing again costs nothing.
import * as db from "./db.js";

export const LANG_NAMES = {
  de: "German", en: "English", tr: "Turkish", fr: "French", es: "Spanish", it: "Italian",
  nl: "Dutch", pt: "Portuguese", pl: "Polish", sv: "Swedish",
};

async function cached(key, compute) {
  try {
    const hit = await db.get("cache", key);
    if (hit) return hit.v;
  } catch (e) { /* cache is optional */ }
  const v = await compute();
  if (v != null) db.put("cache", { k: key, v, t: Date.now() }).catch(() => {});
  return v;
}

// ---------- on-device (Chrome) ----------
// Some browsers expose the API but never answer, or need to download a language model first.
// We never let that block a lookup: slow or missing on-device translation falls back to online.
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
const statusMemo = new Map();
const translators = new Map(); // key -> Translator instance
const pending = new Map(); // key -> Promise<Translator> while a model downloads

export async function onDeviceStatus(src, tgt) {
  if (!("Translator" in self)) return "missing";
  const key = src + ">" + tgt;
  if (translators.has(key)) return "available";
  if (statusMemo.has(key)) return statusMemo.get(key);
  let st;
  try {
    st = await withTimeout(self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt }), 1500, "unresponsive");
  } catch (e) {
    st = "unavailable";
  }
  statusMemo.set(key, st);
  return st;
}
function startCreate(src, tgt) {
  const key = src + ">" + tgt;
  if (translators.has(key)) return Promise.resolve(translators.get(key));
  if (!pending.has(key)) {
    const p = self.Translator.create({ sourceLanguage: src, targetLanguage: tgt })
      .then((tr) => { translators.set(key, tr); statusMemo.set(key, "available"); return tr; })
      .finally(() => pending.delete(key));
    p.catch(() => {});
    pending.set(key, p);
  }
  return pending.get(key);
}
// Returns translated text, or null when on-device translation isn't ready right now.
async function onDeviceTranslate(text, src, tgt, waitForDownload) {
  const st = await onDeviceStatus(src, tgt);
  if (st === "missing" || st === "unavailable" || st === "unresponsive") return null;
  let tr = translators.get(src + ">" + tgt);
  if (!tr) {
    const creating = startCreate(src, tgt);
    // "available" models load fast; "downloadable" ones download in the background while online translation is used
    tr = await withTimeout(creating, st === "available" || waitForDownload ? (waitForDownload ? 120000 : 4000) : 50, null);
    if (!tr) return null;
  }
  return withTimeout(tr.translate(text), 10000, null);
}

// ---------- MyMemory ----------
function decodeEntities(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
export async function onlineCharsToday() {
  return (await db.kvGet("mm-" + today(), 0)) || 0;
}
async function addChars(n) {
  const k = "mm-" + today();
  await db.kvSet(k, ((await db.kvGet(k, 0)) || 0) + n);
}
function chunks(text, max = 450) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(", ", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
export class QuotaError extends Error {}
async function myMemoryTranslate(text, src, tgt, email) {
  const parts = [];
  for (const piece of chunks(text)) {
    let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(piece)}&langpair=${src}|${tgt}`;
    if (email) url += `&de=${encodeURIComponent(email)}`;
    const res = await fetch(url);
    if (res.status === 429) throw new QuotaError("Today's free online translations are used up.");
    if (!res.ok) throw new Error("The online translator didn't answer.");
    const j = await res.json();
    const out = j?.responseData?.translatedText || "";
    if (/MYMEMORY WARNING|USED ALL AVAILABLE FREE/i.test(out) || String(j.responseStatus) === "429") {
      throw new QuotaError("Today's free online translations are used up.");
    }
    if (String(j.responseStatus) !== "200") throw new Error(j.responseDetails || "The online translator returned an error.");
    parts.push(decodeEntities(out));
    addChars(piece.length).catch(() => {});
  }
  return parts.join(" ");
}

// ---------- public: translate ----------
// settings.engine: "auto" | "device" | "online"
export async function translate(text, src, tgt, settings) {
  text = text.trim();
  if (!text || src === tgt) return { text, engine: "none" };
  const key = `t|${src}|${tgt}|${text}`;
  const hit = await db.get("cache", key).catch(() => null);
  if (hit) return hit.v;
  let result = null, lastErr = null;
  const tryDevice = settings.engine !== "online";
  const tryOnline = settings.engine !== "device";
  if (tryDevice && "Translator" in self) {
    try {
      const out = await onDeviceTranslate(text, src, tgt, !tryOnline);
      if (out) result = { text: out, engine: "device" };
    } catch (e) { lastErr = e; }
  }
  if (!result && tryOnline) {
    try {
      result = { text: await myMemoryTranslate(text, src, tgt, settings.email), engine: "online" };
    } catch (e) { lastErr = e; }
  }
  if (!result) {
    if (!tryOnline) throw new Error("On-device translation isn't available in this browser for this language. Switch the engine to Automatic in Settings.");
    throw lastErr || new Error("No translator is available right now.");
  }
  db.put("cache", { k: key, v: result, t: Date.now() }).catch(() => {});
  return result;
}

// ---------- Wiktionary ----------
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}
function formOfTarget(html) {
  if (!/form-of|inflection of|plural of|participle of|singular of|form of|genitive|dative|accusative|superlative|comparative/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const link = doc.querySelector(".form-of-definition-link a, i.mention a, a[title]");
  const t = link && (link.getAttribute("title") || link.textContent);
  return t ? t.replace(/#.*$/, "").trim() : null;
}
async function wiktionaryRaw(word) {
  return cached(`w|${word}`, async () => {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}?redirect=true`);
    if (res.status === 404) return {};
    if (!res.ok) throw new Error("Wiktionary didn't answer.");
    return res.json();
  });
}
function entriesFor(data, lang) {
  const list = (data && data[lang]) || [];
  return list.map((e) => {
    const defs = (e.definitions || []).filter((d) => d.definition && d.definition.trim());
    let formOf = null;
    const texts = [];
    for (const d of defs) {
      const f = formOfTarget(d.definition);
      if (f && !formOf) formOf = f;
      const t = htmlToText(d.definition);
      if (t) texts.push(t);
    }
    return { pos: e.partOfSpeech || "", defs: texts.slice(0, 4), formOf };
  }).filter((e) => e.defs.length);
}

// Look a word up in Wiktionary. Returns {lemma, entries:[{pos, defs, formOf}], lemmaEntries} or null.
export async function lookupWord(word, lang) {
  const variants = [...new Set([word, word.toLowerCase(), word[0].toUpperCase() + word.slice(1).toLowerCase()])];
  let found = null, used = word;
  for (const v of variants) {
    let data;
    try { data = await wiktionaryRaw(v); } catch (e) { if (!found) throw e; }
    const entries = entriesFor(data, lang);
    if (entries.length) { found = entries; used = v; break; }
  }
  if (!found) return null;
  const lemma = found.find((e) => e.formOf)?.formOf || null;
  let lemmaEntries = [];
  if (lemma && lemma.toLowerCase() !== used.toLowerCase()) {
    try {
      lemmaEntries = entriesFor(await wiktionaryRaw(lemma), lang).filter((e) => !e.formOf);
    } catch (e) { /* the form entry is still useful */ }
  }
  return { word: used, lemma: lemma || used, entries: found, lemmaEntries };
}
