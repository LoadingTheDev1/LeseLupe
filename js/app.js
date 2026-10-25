import * as db from "./db.js";
import { importFile, buildSections, finalizeBook } from "./importers.js";
import { WORD_RE, wordAt, sentenceAt, countWords } from "./text.js";
import { translate, lookupWord, LANG_NAMES, onDeviceStatus, onlineCharsToday, QuotaError } from "./translate.js";
import { searchGutenberg, fetchGutenbergBook } from "./gutenberg.js";
import { SAMPLE_BOOK } from "./sample.js";

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const HL = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // trusted static markup only (icons)
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (typeof v === "boolean" || k === "value") el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const I = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  speak: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg>',
  toc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
  type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18l5-12 5 12M5.8 14h6.4M15 18l3-7 3 7M15.9 16h4.2"/></svg>',
};
const icon = (name, cls = "ico") => h("span", { class: cls, html: I[name] });

function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec > 0 ? "<1 min" : "0 min";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const LOCALES = { de: "de-DE", en: "en-GB", tr: "tr-TR", fr: "fr-FR", es: "es-ES", it: "it-IT", nl: "nl-NL", pt: "pt-PT", pl: "pl-PL", sv: "sv-SE" };

function speak(text, lang) {
  if (!("speechSynthesis" in window)) { toast("Your browser can't read text aloud."); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LOCALES[lang] || lang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

function toast(msg, kind = "") {
  const box = $("#toasts");
  const t = h("div", { class: "toast " + kind, role: kind === "error" ? "alert" : "status" }, msg);
  while (box.children.length >= 2) box.firstElementChild.remove();
  box.append(t);
  setTimeout(() => t.classList.add("out"), 3200);
  setTimeout(() => t.remove(), 3700);
}
function busy(msg) {
  const b = $("#busy");
  if (msg == null) { b.hidden = true; return; }
  $("#busyMsg").textContent = msg;
  b.hidden = false;
}
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function hueFor(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return ["#2f6f68", "#7a4a2f", "#3d5a8a", "#6b4f7a", "#8a6a1f", "#4f6b3a", "#8a3f4a"][x % 7];
}
async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* optional */ }
}

// ---------------------------------------------------------------- settings
let settings = {
  target: (navigator.language || "").toLowerCase().startsWith("tr") ? "tr" : "en",
  engine: "auto",
  theme: "system",
  fontSize: 19,
  lineHeight: 1.7,
  email: "",
  tapMode: "word",
  lastList: "My words",
  autoSentence: false, // sentence translation in the word popup is a button unless turned on
};
async function loadSettings() {
  const s = await db.kvGet("settings").catch(() => null);
  if (s) settings = { ...settings, ...s };
  applyLook();
}
function saveSettings() {
  db.kvSet("settings", settings).catch(() => {});
  applyLook();
}
function applyLook() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  root.style.setProperty("--read-size", settings.fontSize + "px");
  root.style.setProperty("--read-lh", String(settings.lineHeight));
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bar").trim() || "#17675f";
}

// ---------------------------------------------------------------- router
let cleanup = null;
async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  closeSheet();
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const name = parts[0] || "library";
  document.body.classList.toggle("reading", name === "read");
  document.querySelectorAll(".tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.route === name ? "page" : "false"));
  view.textContent = "";
  window.scrollTo(0, 0);
  try {
    if (name === "read" && parts[1]) await renderReader(decodeURIComponent(parts[1]));
    else if (name === "discover") await renderDiscover();
    else if (name === "words") await renderWords();
    else if (name === "stats") await renderStats();
    else if (name === "settings") await renderSettings();
    else await renderLibrary();
  } catch (e) {
    console.error(e);
    view.append(h("div", { class: "wrap" }, h("p", { class: "error" }, "Something went wrong: " + e.message)));
  }
}

// ---------------------------------------------------------------- library
async function saveNewBook(book, extra = {}) {
  const id = db.uid();
  const sections = buildSections(book.blocks);
  const totalWords = book.blocks.reduce((n, b) => n + countWords(b.s), 0);
  await db.put("content", { id, blocks: book.blocks });
  await db.put("books", {
    id, title: book.title, author: book.author, lang: book.lang, sections, totalWords,
    blockCount: book.blocks.length, addedAt: Date.now(), lastOpenedAt: 0,
    progress: { block: 0, percent: 0, seconds: 0, finishedAt: null }, ...extra,
  });
  requestPersist();
  return id;
}

async function handleFiles(files) {
  let lastId = null;
  for (const f of files) {
    busy(`Importing ${f.name}…`);
    try {
      const book = await importFile(f, (m) => busy(`${f.name}: ${m}`));
      lastId = await saveNewBook(book, { source: "file" });
      toast(`Added “${book.title}”`);
    } catch (e) {
      console.error(e);
      toast(`${f.name}: ${e.message}`, "error");
    }
  }
  busy(null);
  if (location.hash.replace(/^#\/?/, "").split("/")[0] in { "": 1, library: 1 }) route();
  return lastId;
}

function fileButton(label, primary = true) {
  const input = h("input", { type: "file", accept: ".epub,.pdf,.txt,application/epub+zip,application/pdf,text/plain", multiple: true, class: "visually-hidden", id: "fileIn" + Math.random().toString(36).slice(2, 7) });
  input.addEventListener("change", () => { if (input.files.length) handleFiles([...input.files]); input.value = ""; });
  const lab = h("label", { class: "btn" + (primary ? " primary" : ""), for: input.id, tabindex: 0, role: "button" }, icon("upload"), label);
  lab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  return h("span", { class: "file-btn" }, input, lab);
}

async function renderLibrary() {
  const books = (await db.getAll("books")).sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
  const words = await db.getAll("words");
  const wcount = {};
  words.forEach((w) => { wcount[w.bookId] = (wcount[w.bookId] || 0) + 1; });

  const wrap = h("div", { class: "wrap" });
  wrap.append(h("div", { class: "head-row" },
    h("div", {}, h("h1", {}, "Library"), h("p", { class: "lede" }, "Tap any word or sentence while you read to see its translation.")),
    h("div", { class: "row-actions" }, fileButton("Import book"), h("a", { class: "btn", href: "#/discover" }, "Find free books"))));

  if (!books.length) {
    wrap.append(h("section", { class: "empty card" },
      h("h2", {}, "Start with a book"),
      h("p", {}, "Import an EPUB, PDF or TXT file from your device, or pick a free classic from Project Gutenberg. Your books and word lists stay on this device."),
      h("div", { class: "row-actions" },
        fileButton("Import a file"),
        h("button", { class: "btn", onclick: async () => {
          const id = await saveNewBook(finalizeBook(structuredClone(SAMPLE_BOOK)), { source: "sample" });
          location.hash = "#/read/" + id;
        } }, "Try the sample story"),
        h("a", { class: "btn ghost", href: "#/discover" }, "Browse Gutenberg")),
      h("p", { class: "fine" }, "You can also drag files onto this page.")));
  } else {
    const grid = h("div", { class: "books" });
    for (const b of books) grid.append(bookCard(b, wcount[b.id] || 0));
    wrap.append(grid);
  }
  view.append(wrap);

  const onDrag = (e) => { e.preventDefault(); document.body.classList.add("dragging"); };
  const onLeave = (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); };
  const onDrop = (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) handleFiles(files);
  };
  window.addEventListener("dragover", onDrag);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  cleanup = () => {
    window.removeEventListener("dragover", onDrag);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
  };
}

function langPair(b) {
  return `${(b.lang || "?").toUpperCase()} → ${settings.target.toUpperCase()}`;
}

function bookCard(b, saved) {
  const pct = Math.round(b.progress?.percent || 0);
  const menu = h("div", { class: "card-menu", hidden: true });
  const card = h("article", { class: "book card" },
    h("a", { class: "book-link", href: "#/read/" + encodeURIComponent(b.id), "aria-label": `Open ${b.title}` }),
    h("div", { class: "spine", style: { background: hueFor(b.title) } }, h("span", {}, (b.title || "?").slice(0, 1))),
    h("div", { class: "book-body" },
      h("h3", { class: "book-title" }, b.title),
      b.author ? h("p", { class: "book-author" }, b.author) : null,
      h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Progress" }, h("span", { style: { width: pct + "%" } })),
      h("p", { class: "book-meta" },
        h("span", {}, pct >= 99 ? "Finished" : `${pct}% read`),
        h("span", {}, fmtDuration(b.progress?.seconds)),
        h("span", {}, `${saved} ${saved === 1 ? "word" : "words"}`),
        h("span", { class: "chip" }, langPair(b)))),
    h("button", { class: "icon-btn more", "aria-label": `Options for ${b.title}`, html: I.more, onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }),
    menu);

  const langSel = h("select", { "aria-label": "Book language" },
    Object.entries(LANG_NAMES).map(([k, v]) => h("option", { value: k, selected: k === b.lang }, v)));
  langSel.addEventListener("change", async () => { b.lang = langSel.value; await db.put("books", b); toast(`Language set to ${LANG_NAMES[b.lang]}`); route(); });
  const del = h("button", { class: "btn danger small" }, "Delete book");
  del.addEventListener("click", async () => {
    if (del.dataset.confirm !== "1") { del.dataset.confirm = "1"; del.textContent = "Tap again to delete"; return; }
    await db.del("books", b.id);
    await db.del("content", b.id);
    toast(`Deleted “${b.title}”. Saved words were kept.`);
    route();
  });
  menu.append(h("label", { class: "field" }, h("span", {}, "Book language"), langSel), del);
  return card;
}

// ---------------------------------------------------------------- reader
let R = null;

async function renderReader(id) {
  const book = await db.get("books", id);
  const content = book && (await db.get("content", id));
  if (!book || !content) { toast("That book isn't in your library anymore."); location.hash = "#/library"; return; }
  book.lastOpenedAt = Date.now();
  db.put("books", book);
  const blocks = content.blocks;
  const before = new Array(blocks.length + 1);
  before[0] = 0;
  for (let i = 0; i < blocks.length; i++) before[i + 1] = before[i] + countWords(blocks[i].s);
  const sections = book.sections && book.sections.length ? book.sections : buildSections(blocks);

  R = { book, blocks, before, sections, sec: 0, pendingSecs: 0, lastActivity: Date.now() };

  const tocSel = h("select", { class: "toc", "aria-label": "Chapter" }, sections.map((s, i) => h("option", { value: String(i) }, s.title)));
  tocSel.addEventListener("change", () => showSection(+tocSel.value, null));
  const modeBtn = h("button", { class: "btn small mode", "aria-pressed": settings.tapMode === "sentence" ? "true" : "false", title: "Switch between tapping words and tapping sentences" }, settings.tapMode === "sentence" ? "Sentence" : "Word");
  modeBtn.addEventListener("click", () => {
    settings.tapMode = settings.tapMode === "sentence" ? "word" : "sentence";
    saveSettings();
    modeBtn.textContent = settings.tapMode === "sentence" ? "Sentence" : "Word";
    modeBtn.setAttribute("aria-pressed", settings.tapMode === "sentence" ? "true" : "false");
    toast(settings.tapMode === "sentence" ? "Tap a sentence to translate it" : "Tap a word to look it up");
  });
  const typeBtn = h("button", { class: "icon-btn", "aria-label": "Text size", html: I.type });
  const typePanel = h("div", { class: "type-panel card", hidden: true },
    h("label", { class: "field" }, h("span", {}, "Text size"),
      h("input", { type: "range", min: 15, max: 28, step: 1, value: String(settings.fontSize), oninput: (e) => { settings.fontSize = +e.target.value; saveSettings(); } })),
    h("label", { class: "field" }, h("span", {}, "Line spacing"),
      h("input", { type: "range", min: 1.4, max: 2.1, step: 0.05, value: String(settings.lineHeight), oninput: (e) => { settings.lineHeight = +e.target.value; saveSettings(); } })));
  typeBtn.addEventListener("click", () => { typePanel.hidden = !typePanel.hidden; });

  const pctEl = h("span", { class: "pct" }, "0%");
  const article = h("article", { class: "page", lang: book.lang, id: "page" });
  const barFill = h("span");
  const prevBtn = h("button", { class: "btn small", onclick: () => go(-1) }, icon("prev"), "Previous");
  const nextBtn = h("button", { class: "btn small", onclick: () => go(1) }, "Next", icon("next"));
  const selBtn = h("button", { class: "btn primary sel-btn", hidden: true }, "Translate selection");

  view.append(h("div", { class: "reader" },
    h("header", { class: "rbar" },
      h("a", { class: "icon-btn", href: "#/library", "aria-label": "Back to library", html: I.back }),
      h("div", { class: "rtitle" }, h("strong", {}, book.title), tocSel),
      modeBtn, typeBtn, pctEl),
    typePanel,
    article,
    h("nav", { class: "secnav", "aria-label": "Chapters" }, prevBtn, h("div", { class: "bar thin" }, barFill), nextBtn),
    selBtn));
  R.els = { tocSel, article, pctEl, barFill, prevBtn, nextBtn, selBtn };

  function go(d) {
    const n = R.sec + d;
    if (n >= 0 && n < sections.length) showSection(n, null);
  }

  // start where the reader left off
  const startBlock = book.progress?.block || 0;
  let startSec = sections.findIndex((s) => startBlock >= s.start && startBlock < s.end);
  if (startSec < 0) startSec = 0;
  showSection(startSec, startBlock);

  // interactions
  article.addEventListener("click", onTextClick);
  const onScroll = () => { R.lastActivity = Date.now(); scheduleProgress(); };
  const onAct = () => { R.lastActivity = Date.now(); };
  const onSel = () => {
    const sel = getSelection();
    const ok = sel && !sel.isCollapsed && article.contains(sel.anchorNode) && sel.toString().trim().length > 1;
    selBtn.hidden = !ok;
  };
  selBtn.addEventListener("mousedown", (e) => e.preventDefault());
  selBtn.addEventListener("click", () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    const range = sel.getRangeAt(0).cloneRange();
    selBtn.hidden = true;
    openPhrase(text, range);
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pointerdown", onAct);
  window.addEventListener("keydown", onAct);
  document.addEventListener("selectionchange", onSel);
  const timer = setInterval(tick, 5000);
  const onHide = () => { if (document.visibilityState === "hidden") flushProgress(); };
  document.addEventListener("visibilitychange", onHide);

  cleanup = () => {
    clearInterval(timer);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("pointerdown", onAct);
    window.removeEventListener("keydown", onAct);
    document.removeEventListener("selectionchange", onSel);
    document.removeEventListener("visibilitychange", onHide);
    flushProgress();
    if (HL) { CSS.highlights.delete("lu-active"); CSS.highlights.delete("lu-saved"); }
    R = null;
  };
}

function showSection(i, scrollToBlock) {
  const s = R.sections[i];
  R.sec = i;
  closeSheet();
  const { article, tocSel, prevBtn, nextBtn } = R.els;
  article.textContent = "";
  for (let k = s.start; k < s.end; k++) {
    const b = R.blocks[k];
    article.append(h(b.h ? "h2" : "p", { dataset: { i: String(k) } }, b.s));
  }
  if (i < R.sections.length - 1) {
    article.append(h("div", { class: "endnav" },
      h("button", { class: "btn primary", onclick: () => showSection(i + 1, null) }, `Next: ${R.sections[i + 1].title}`)));
  } else {
    article.append(h("div", { class: "endnav" }, h("p", { class: "fine" }, "End of the book.")));
  }
  tocSel.value = String(i);
  prevBtn.disabled = i === 0;
  nextBtn.disabled = i === R.sections.length - 1;
  paintSaved();
  requestAnimationFrame(() => {
    if (scrollToBlock != null && scrollToBlock > s.start) {
      const el = article.querySelector(`[data-i="${scrollToBlock}"]`);
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - topOffset() - 8);
    } else {
      window.scrollTo(0, 0);
    }
    updateProgress(true);
  });
}

function topOffset() {
  const bar = $(".rbar");
  return bar ? bar.getBoundingClientRect().bottom : 0;
}

let progressQueued = false;
function scheduleProgress() {
  if (progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(() => { progressQueued = false; updateProgress(false); });
}
function updateProgress(force) {
  if (!R) return;
  const { article } = R.els;
  const top = topOffset() + 4;
  let idx = R.sections[R.sec].start;
  for (const el of article.children) {
    if (!el.dataset.i) continue;
    if (el.getBoundingClientRect().bottom > top) { idx = +el.dataset.i; break; }
  }
  const total = R.before[R.before.length - 1] || 1;
  let pct = (R.before[idx] / total) * 100;
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 6;
  if (atEnd && R.sec === R.sections.length - 1) pct = 100;
  else if (atEnd) pct = (R.before[R.sections[R.sec].end] / total) * 100;
  const p = R.book.progress || (R.book.progress = { block: 0, percent: 0, seconds: 0 });
  const changed = p.block !== idx || Math.abs(p.percent - pct) > 0.05;
  p.block = idx;
  p.percent = pct;
  if (pct >= 99.5 && !p.finishedAt) p.finishedAt = Date.now();
  R.els.pctEl.textContent = Math.round(pct) + "%";
  R.els.barFill.style.width = pct + "%";
  if (changed || force) R.dirty = true;
}

async function tick() {
  if (!R) return;
  if (document.visibilityState !== "visible" || Date.now() - R.lastActivity > 90000) return;
  R.book.progress.seconds = (R.book.progress.seconds || 0) + 5;
  R.pendingSecs += 5;
  R.dirty = true;
  if (R.pendingSecs >= 15) flushProgress();
}
async function flushProgress() {
  if (!R) return;
  const secs = R.pendingSecs;
  R.pendingSecs = 0;
  if (R.dirty) { R.dirty = false; await db.put("books", R.book).catch(() => {}); }
  if (secs > 0) {
    const k = today();
    const row = (await db.get("days", k).catch(() => null)) || { date: k, seconds: 0 };
    row.seconds += secs;
    await db.put("days", row).catch(() => {});
  }
}

async function paintSaved() {
  if (!HL || !R) return;
  const words = await db.getAll("words");
  const keys = new Set(words.filter((w) => w.lang === R.book.lang && !/\s/.test(w.key)).map((w) => w.key));
  const ranges = [];
  if (keys.size) {
    for (const el of R.els.article.querySelectorAll("[data-i]")) {
      const node = el.firstChild;
      if (!node || node.nodeType !== 3) continue;
      WORD_RE.lastIndex = 0;
      let m;
      while ((m = WORD_RE.exec(node.data))) {
        if (keys.has(m[0].toLowerCase())) {
          const r = document.createRange();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          ranges.push(r);
        }
      }
    }
  }
  CSS.highlights.set("lu-saved", new Highlight(...ranges));
}

// --- tapping text
let activeMark = null;
function highlightRange(range) {
  clearHighlight();
  if (HL) CSS.highlights.set("lu-active", new Highlight(range));
  else {
    const m = h("mark", { class: "lu-active" });
    try { range.surroundContents(m); activeMark = m; } catch (e) { /* skip highlight */ }
  }
}
function clearHighlight() {
  if (HL) { CSS.highlights.delete("lu-active"); return; }
  if (activeMark && activeMark.parentNode) {
    const p = activeMark.parentNode;
    p.replaceChild(document.createTextNode(activeMark.textContent), activeMark);
    p.normalize();
  }
  activeMark = null;
}
function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}
function rangeContains(range, x, y) {
  for (const r of range.getClientRects()) {
    if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) return true;
  }
  return false;
}

function onTextClick(e) {
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 1) return; // selection is handled by the floating button
  if (!HL) clearHighlight();
  const hit = caretAt(e.clientX, e.clientY);
  if (!hit || hit.node.nodeType !== 3) { closeSheet(); return; }
  const el = hit.node.parentElement && hit.node.parentElement.closest("[data-i]");
  if (!el) { closeSheet(); return; }
  const node = el.firstChild;
  if (!node || node.nodeType !== 3 || node !== hit.node) { closeSheet(); return; }
  const text = node.data;
  const sentence = sentenceAt(text, hit.offset);
  if (settings.tapMode === "sentence") {
    const r = document.createRange();
    r.setStart(node, sentence.start);
    r.setEnd(node, Math.min(sentence.end, text.length));
    if (!rangeContains(r, e.clientX, e.clientY)) { closeSheet(); return; }
    highlightRange(r);
    openSentence(sentence.text, r);
    return;
  }
  const w = wordAt(text, hit.offset);
  if (!w) { closeSheet(); return; }
  const r = document.createRange();
  r.setStart(node, w.start);
  r.setEnd(node, w.end);
  if (!rangeContains(r, e.clientX, e.clientY)) { closeSheet(); return; }
  const anchorRect = r.getBoundingClientRect();
  highlightRange(r);
  openWord(w.word, sentence.text, anchorRect);
}

// ---------------------------------------------------------------- lookup sheet
const sheet = $("#sheet");
let lookupToken = 0;

function closeSheet() {
  sheet.hidden = true;
  sheet.textContent = "";
  lookupToken++;
  clearHighlight();
}
function placeSheet(rect) {
  if (window.matchMedia("(max-width: 700px)").matches || !rect) {
    sheet.classList.add("bottom");
    sheet.style.left = sheet.style.top = "";
    return;
  }
  sheet.classList.remove("bottom");
  const w = sheet.offsetWidth, hgt = sheet.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - w / 2), vw - w - 12);
  const below = rect.bottom + 10, above = rect.top - hgt - 10;
  const top = below + hgt < vh - 8 || above < 70 ? below : above;
  sheet.style.left = left + "px";
  sheet.style.top = Math.max(8, top) + "px";
}
function errorText(e) {
  if (e instanceof QuotaError) return "Today's free online translations are used up. Add your email in Settings to raise the daily limit, or use Chrome on a computer for unlimited on-device translation.";
  if (!navigator.onLine) return "You're offline. Translations need the internet unless your browser can translate on the device.";
  return e.message || "Couldn't translate this right now.";
}
function engineNote(engine) {
  return engine === "device" ? "Translated on your device" : engine === "online" ? "Translated by MyMemory" : "";
}

function sheetFrame(titleNode, onSpeak) {
  sheet.textContent = "";
  const body = h("div", { class: "sheet-body" });
  sheet.append(
    h("div", { class: "sheet-head" }, titleNode,
      onSpeak ? h("button", { class: "icon-btn", "aria-label": "Read aloud", html: I.speak, onclick: onSpeak }) : null,
      h("button", { class: "icon-btn close", "aria-label": "Close", html: I.close, onclick: closeSheet })),
    body);
  sheet.hidden = false;
  return body;
}

async function listNames() {
  const lists = (await db.getAll("lists")).map((l) => l.name);
  if (!lists.includes("My words")) lists.unshift("My words");
  return lists;
}

async function saveControls(getEntry) {
  const lists = await listNames();
  if (!lists.includes(settings.lastList)) settings.lastList = "My words";
  const sel = h("select", { class: "list-sel", "aria-label": "Word list" }, lists.map((n) => h("option", { value: n, selected: n === settings.lastList }, n)));
  const btn = h("button", { class: "btn primary small save" }, icon("star"), "Save");
  let savedId = null;
  async function refresh() {
    const e = getEntry();
    const all = await db.getAll("words");
    const hit = all.find((w) => w.key === e.key && w.bookId === e.bookId && w.list === sel.value);
    savedId = hit ? hit.id : null;
    btn.classList.toggle("on", !!savedId);
    btn.lastChild.textContent = savedId ? "Saved" : "Save";
  }
  sel.addEventListener("change", () => { settings.lastList = sel.value; saveSettings(); refresh(); });
  btn.addEventListener("click", async () => {
    if (savedId) {
      await db.del("words", savedId);
      toast("Removed from " + sel.value);
    } else {
      const e = getEntry();
      await db.put("words", { ...e, id: db.uid(), list: sel.value, addedAt: Date.now() });
      toast("Saved to " + sel.value);
    }
    await refresh();
    paintSaved();
  });
  refresh();
  return h("div", { class: "save-row" }, btn, sel);
}

async function openWord(word, sentence, rect) {
  const token = ++lookupToken;
  const src = R.book.lang, tgt = settings.target;
  const entry = {
    key: word.toLowerCase(), word, lemma: "", pos: "", tr: "", def: "", sentence, sentenceTr: "",
    bookId: R.book.id, bookTitle: R.book.title, lang: src, target: tgt,
  };
  const body = sheetFrame(h("div", { class: "sheet-title" }, h("span", { class: "w" }, word), h("span", { class: "pos" })), () => speak(word, src));
  const lemmaEl = h("p", { class: "lemma", hidden: true });
  const mainEl = h("div", { class: "meaning" }, h("p", { class: "loading" }, "Looking up…"));
  const extraEl = h("div", { class: "extra" });
  const ctxTr = h("p", { class: "ctx-tr" }, src === tgt ? "" : "Translating the sentence…");
  const ctx = h("div", { class: "ctx" }, h("p", { class: "label" }, "In this sentence"), h("p", { class: "ctx-src", lang: src }, sentence), src === tgt ? null : ctxTr);
  const note = h("p", { class: "source-note" });
  body.append(lemmaEl, mainEl, extraEl, ctx, await saveControls(() => entry), note);
  placeSheet(rect);
  const notes = new Set();
  const addNote = (t) => { if (t) { notes.add(t); note.textContent = [...notes].join(" · "); } };

  // meaning: Wiktionary (base form, part of speech, definitions in English)
  const dictP = lookupWord(word, src).catch(() => null);

  // sentence in context (automatic, or on request to save the free online allowance)
  if (src !== tgt) {
    const runCtx = () => {
      ctxTr.textContent = "Translating the sentence…";
      translate(sentence, src, tgt, settings).then((r) => {
        if (token !== lookupToken) return;
        ctxTr.textContent = r.text;
        entry.sentenceTr = r.text;
        addNote(engineNote(r.engine));
        placeSheet(rect);
      }).catch((e) => { if (token === lookupToken) { ctxTr.textContent = errorText(e); ctxTr.classList.add("err"); } });
    };
    if (settings.autoSentence) runCtx();
    else { ctxTr.textContent = ""; ctxTr.append(h("button", { class: "btn small ctx-btn", onclick: runCtx }, "Translate sentence")); }
  }

  const dict = await dictP;
  if (token !== lookupToken) return;
  const posEl = sheet.querySelector(".pos");
  if (dict) {
    addNote("Meanings from Wiktionary (CC BY-SA)");
    const lemma = dict.lemma;
    entry.lemma = lemma !== word ? lemma : "";
    const firstPos = (dict.lemmaEntries[0] || dict.entries[0] || {}).pos || "";
    entry.pos = firstPos;
    posEl.textContent = firstPos.toLowerCase();
    if (lemma && lemma.toLowerCase() !== word.toLowerCase()) {
      lemmaEl.hidden = false;
      lemmaEl.textContent = "";
      lemmaEl.append("Base form: ", h("b", { lang: src }, lemma));
    }
    const formLine = dict.entries.find((e) => e.formOf)?.defs[0];
    const senses = dict.lemmaEntries.length ? dict.lemmaEntries : dict.entries.filter((e) => !e.formOf);
    const english = senses.flatMap((e) => e.defs.map((d) => ({ pos: e.pos, d }))).slice(0, 4);
    entry.def = english.slice(0, 2).map((x) => x.d).join("; ");
    if (tgt === "en" || src === tgt) {
      mainEl.textContent = "";
      if (english.length) {
        mainEl.append(h("ol", { class: "senses" }, english.map((x) => h("li", {}, x.d))));
        entry.tr = english[0].d;
      } else if (formLine) {
        mainEl.append(h("p", {}, formLine));
        entry.tr = formLine;
      }
      if (formLine && english.length) extraEl.append(h("p", { class: "fine" }, formLine));
    }
  }

  // main translation for Turkish (or anything Wiktionary didn't cover)
  if (tgt !== "en" && src !== tgt || !dict || !entry.tr) {
    const base = entry.lemma || word;
    try {
      const r = await translate(base, src, tgt, settings);
      if (token !== lookupToken) return;
      mainEl.textContent = "";
      mainEl.append(h("p", { class: "main-tr" }, r.text));
      entry.tr = r.text;
      addNote(engineNote(r.engine));
      if (dict && entry.def && tgt !== "en") extraEl.append(h("p", { class: "fine" }, "English: " + entry.def));
    } catch (e) {
      if (token !== lookupToken) return;
      if (!entry.tr) { mainEl.textContent = ""; mainEl.append(h("p", { class: "err" }, errorText(e))); }
    }
  }
  placeSheet(rect);
}

async function openSentence(text, range) {
  return openText(text, range, "Sentence");
}
async function openPhrase(text, range) {
  if (text.length > 1200) text = text.slice(0, 1200);
  return openText(text, range, "Selection");
}
async function openText(text, range, label) {
  if (!R) return;
  if (range) highlightRange(range);
  const token = ++lookupToken;
  const src = R.book.lang, tgt = settings.target;
  const rect = range ? range.getBoundingClientRect() : null;
  const entry = { key: text.toLowerCase(), word: text, lemma: "", pos: label.toLowerCase(), tr: "", def: "", sentence: text, sentenceTr: "", bookId: R.book.id, bookTitle: R.book.title, lang: src, target: tgt };
  const body = sheetFrame(h("div", { class: "sheet-title" }, h("span", { class: "label" }, label)), () => speak(text, src));
  const out = h("p", { class: "main-tr" }, src === tgt ? "" : "Translating…");
  const note = h("p", { class: "source-note" });
  body.append(h("p", { class: "ctx-src big", lang: src }, text), out, await saveControls(() => entry), note);
  placeSheet(rect);
  if (src === tgt) return;
  try {
    const r = await translate(text, src, tgt, settings);
    if (token !== lookupToken) return;
    out.textContent = r.text;
    entry.tr = entry.sentenceTr = r.text;
    note.textContent = engineNote(r.engine);
  } catch (e) {
    if (token !== lookupToken) return;
    out.textContent = errorText(e);
    out.classList.add("err");
  }
  placeSheet(rect);
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
document.addEventListener("pointerdown", (e) => {
  if (sheet.hidden) return;
  if (sheet.contains(e.target) || (e.target.closest && e.target.closest("#page, .sel-btn"))) return;
  closeSheet();
});
window.addEventListener("resize", () => { if (!sheet.hidden) sheet.classList.toggle("bottom", window.matchMedia("(max-width: 700px)").matches); });

// ---------------------------------------------------------------- words
const wordsState = { list: "All", book: "", q: "" };

async function renderWords() {
  const lists = await listNames();
  const all = (await db.getAll("words")).sort((a, b) => b.addedAt - a.addedAt);
  const books = await db.getAll("books");
  const titles = Object.fromEntries(books.map((b) => [b.id, b.title]));
  if (wordsState.list !== "All" && !lists.includes(wordsState.list)) wordsState.list = "All";

  const wrap = h("div", { class: "wrap" });
  const filtered = () => all.filter((w) =>
    (wordsState.list === "All" || w.list === wordsState.list) &&
    (!wordsState.book || w.bookId === wordsState.book) &&
    (!wordsState.q || (w.word + " " + w.lemma + " " + w.tr).toLowerCase().includes(wordsState.q.toLowerCase())));

  const chips = h("div", { class: "chips", role: "tablist", "aria-label": "Lists" });
  const drawChips = () => {
    chips.textContent = "";
    ["All", ...lists].forEach((n) => {
      const count = n === "All" ? all.length : all.filter((w) => w.list === n).length;
      chips.append(h("button", { class: "chip-btn", role: "tab", "aria-selected": wordsState.list === n ? "true" : "false", onclick: () => { wordsState.list = n; route(); } }, n, h("span", { class: "count" }, String(count))));
    });
    const input = h("input", { class: "new-list", placeholder: "New list name", "aria-label": "New list name", maxlength: 40 });
    const add = h("button", { class: "chip-btn add" }, "+ New list");
    add.addEventListener("click", async () => {
      if (input.hidden) { input.hidden = false; input.focus(); return; }
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      await db.put("lists", { name, createdAt: Date.now() });
      wordsState.list = name;
      settings.lastList = name;
      saveSettings();
      route();
    });
    input.hidden = true;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add.click(); });
    chips.append(add, input);
  };
  drawChips();

  const search = h("input", { type: "search", placeholder: "Search words", "aria-label": "Search words", value: wordsState.q });
  const bookSel = h("select", { "aria-label": "Filter by book" }, h("option", { value: "" }, "All books"),
    books.map((b) => h("option", { value: b.id, selected: b.id === wordsState.book }, b.title)));
  const listEl = h("ul", { class: "wordlist" });
  const countEl = h("p", { class: "fine" });

  const draw = () => {
    const items = filtered();
    countEl.textContent = `${items.length} ${items.length === 1 ? "entry" : "entries"}`;
    listEl.textContent = "";
    if (!items.length) {
      listEl.append(h("li", { class: "empty-li" }, all.length ? "Nothing matches these filters." : "No saved words yet. While reading, tap a word and press Save."));
      return;
    }
    for (const w of items) {
      const move = h("select", { "aria-label": "Move to list" }, lists.map((n) => h("option", { value: n, selected: n === w.list }, n)));
      move.addEventListener("change", async () => { w.list = move.value; await db.put("words", w); toast("Moved to " + w.list); route(); });
      const del = h("button", { class: "icon-btn", "aria-label": "Delete " + w.word, html: I.close });
      del.addEventListener("click", async () => { await db.del("words", w.id); toast(`Deleted “${w.word}”`); route(); });
      listEl.append(h("li", { class: "wcard" },
        h("div", { class: "wtop" },
          h("span", { class: "w", lang: w.lang }, w.word),
          w.lemma ? h("span", { class: "lem", lang: w.lang }, w.lemma) : null,
          w.pos ? h("span", { class: "pos" }, w.pos.toLowerCase()) : null,
          h("span", { class: "spacer" }),
          h("button", { class: "icon-btn", "aria-label": "Read aloud", html: I.speak, onclick: () => speak(w.word, w.lang) }),
          del),
        w.tr ? h("p", { class: "tr", lang: w.target }, w.tr) : null,
        w.sentence && w.sentence !== w.word ? h("p", { class: "sent", lang: w.lang }, w.sentence) : null,
        w.sentenceTr && w.sentenceTr !== w.tr ? h("p", { class: "sent-tr", lang: w.target }, w.sentenceTr) : null,
        h("div", { class: "wmeta" }, h("span", {}, titles[w.bookId] || w.bookTitle || ""), h("span", {}, new Date(w.addedAt).toLocaleDateString()), move)));
    }
  };
  search.addEventListener("input", () => { wordsState.q = search.value; draw(); });
  bookSel.addEventListener("change", () => { wordsState.book = bookSel.value; draw(); });

  const exportBtn = h("button", { class: "btn" }, "Export CSV");
  exportBtn.addEventListener("click", () => {
    const items = filtered();
    if (!items.length) { toast("Nothing to export yet"); return; }
    const q = (s) => `"${String(s || "").replace(/"/g, '""')}"`;
    const rows = [["Word", "Base form", "Translation", "Sentence", "Sentence translation", "Book", "List", "Added"].map(q).join(",")];
    items.forEach((w) => rows.push([w.word, w.lemma, w.tr, w.sentence, w.sentenceTr, titles[w.bookId] || w.bookTitle, w.list, new Date(w.addedAt).toISOString().slice(0, 10)].map(q).join(",")));
    download(`leselupe-${wordsState.list === "All" ? "words" : wordsState.list.replace(/\W+/g, "-")}.csv`, "﻿" + rows.join("\n"), "text/csv;charset=utf-8");
  });
  const deleteList = wordsState.list !== "All" && wordsState.list !== "My words"
    ? h("button", { class: "btn ghost danger", onclick: async (e) => {
        const b = e.currentTarget;
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again: words move to My words"; return; }
        for (const w of all.filter((x) => x.list === wordsState.list)) { w.list = "My words"; await db.put("words", w); }
        await db.del("lists", wordsState.list);
        wordsState.list = "All";
        route();
      } }, "Delete list")
    : null;

  wrap.append(
    h("div", { class: "head-row" }, h("div", {}, h("h1", {}, "Word lists"), h("p", { class: "lede" }, "Everything you saved while reading, with the sentence it came from.")),
      h("div", { class: "row-actions" }, exportBtn, deleteList)),
    chips,
    h("div", { class: "filters" }, search, bookSel, countEl),
    listEl);
  view.append(wrap);
  draw();
}

// ---------------------------------------------------------------- stats
async function renderStats() {
  const days = await db.getAll("days");
  const books = await db.getAll("books");
  const words = await db.getAll("words");
  const byDay = Object.fromEntries(days.map((d) => [d.date, d.seconds]));
  const totalSec = books.reduce((n, b) => n + (b.progress?.seconds || 0), 0);
  const todaySec = byDay[today()] || 0;
  let streak = 0;
  const d = new Date();
  if ((byDay[dayKey(d)] || 0) < 60) d.setDate(d.getDate() - 1);
  while ((byDay[dayKey(d)] || 0) >= 60) { streak++; d.setDate(d.getDate() - 1); }
  const finished = books.filter((b) => (b.progress?.percent || 0) >= 99).length;
  const wordsRead = books.reduce((n, b) => n + Math.round(((b.progress?.percent || 0) / 100) * (b.totalWords || 0)), 0);

  const wrap = h("div", { class: "wrap" });
  wrap.append(h("div", { class: "head-row" }, h("div", {}, h("h1", {}, "Reading stats"), h("p", { class: "lede" }, "Time counts only while a book is open and you're active."))));
  const tile = (label, value, sub) => h("div", { class: "tile card" }, h("p", { class: "tile-label" }, label), h("p", { class: "tile-value" }, value), sub ? h("p", { class: "fine" }, sub) : null);
  wrap.append(h("div", { class: "tiles" },
    tile("Today", fmtDuration(todaySec)),
    tile("Streak", `${streak} ${streak === 1 ? "day" : "days"}`, "Days with at least 1 minute"),
    tile("Total time", fmtDuration(totalSec)),
    tile("Words saved", String(words.length)),
    tile("Words read", wordsRead.toLocaleString()),
    tile("Books finished", `${finished} of ${books.length}`)));

  // last 14 days
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const x = new Date();
    x.setDate(x.getDate() - i);
    series.push({ k: dayKey(x), label: x.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2), day: x.getDate(), min: Math.round((byDay[dayKey(x)] || 0) / 60) });
  }
  const maxMin = Math.max(10, ...series.map((s) => s.min));
  const chart = h("div", { class: "chart", role: "img", "aria-label": "Minutes read per day over the last 14 days: " + series.map((s) => `${s.k} ${s.min} min`).join(", ") },
    series.map((s) => h("div", { class: "col" + (s.k === today() ? " now" : "") },
      h("span", { class: "val" }, s.min ? String(s.min) : ""),
      h("div", { class: "bar-v", style: { height: Math.max(s.min ? 4 : 1, (s.min / maxMin) * 100) + "%" } }),
      h("span", { class: "day" }, String(s.day)))));
  wrap.append(h("section", { class: "card pad" }, h("h2", {}, "Minutes read, last 14 days"), chart));

  if (books.length) {
    const wc = {};
    words.forEach((w) => { wc[w.bookId] = (wc[w.bookId] || 0) + 1; });
    const rows = books.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)).map((b) => {
      const pct = Math.round(b.progress?.percent || 0);
      return h("tr", {},
        h("td", {}, h("a", { href: "#/read/" + encodeURIComponent(b.id) }, b.title)),
        h("td", { class: "num" }, h("div", { class: "bar mini" }, h("span", { style: { width: pct + "%" } })), `${pct}%`),
        h("td", { class: "num" }, fmtDuration(b.progress?.seconds)),
        h("td", { class: "num" }, String(wc[b.id] || 0)));
    });
    wrap.append(h("section", { class: "card pad" }, h("h2", {}, "Books"),
      h("div", { class: "table-wrap" }, h("table", { class: "stats" },
        h("thead", {}, h("tr", {}, h("th", {}, "Book"), h("th", { class: "num" }, "Read"), h("th", { class: "num" }, "Time"), h("th", { class: "num" }, "Words"))),
        h("tbody", {}, rows)))));
  }
  view.append(wrap);
}

// ---------------------------------------------------------------- discover (Project Gutenberg)
const discoverState = { q: "", lang: "de", results: null, error: null, next: null };

async function renderDiscover() {
  const wrap = h("div", { class: "wrap" });
  const q = h("input", { type: "search", placeholder: "Author or title, e.g. Kafka", "aria-label": "Search Project Gutenberg", value: discoverState.q });
  const lang = h("select", { "aria-label": "Book language" }, Object.entries(LANG_NAMES).map(([k, v]) => h("option", { value: k, selected: k === discoverState.lang }, v)));
  const results = h("div", { class: "results" });
  const form = h("form", { class: "search-row", onsubmit: (e) => { e.preventDefault(); run(q.value.trim(), lang.value); } }, q, lang, h("button", { class: "btn primary", type: "submit" }, "Search"));
  const suggestions = ["Kafka", "Goethe", "Schiller", "Fontane", "Storm", "Grimm", "Heine", "Hoffmann"];
  const chipRow = h("div", { class: "chips" }, h("span", { class: "fine" }, "Try:"), suggestions.map((s) => h("button", { class: "chip-btn", type: "button", onclick: () => { q.value = s; lang.value = "de"; run(s, "de"); } }, s)));

  wrap.append(
    h("div", { class: "head-row" }, h("div", {}, h("h1", {}, "Free books"), h("p", { class: "lede" }, "Public-domain classics from Project Gutenberg. Add one and start reading."))),
    form, chipRow, results,
    h("p", { class: "fine" }, "Project Gutenberg books are free and public domain in the USA. Check the rules in your country before downloading."));
  view.append(wrap);

  async function run(query, language) {
    discoverState.q = query;
    discoverState.lang = language;
    results.textContent = "";
    results.append(h("p", { class: "loading" }, "Searching…"));
    try {
      const data = await searchGutenberg(query, language);
      discoverState.results = data.results || [];
      draw();
    } catch (e) {
      results.textContent = "";
      const url = `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}`;
      results.append(h("div", { class: "card pad" },
        h("p", {}, "Couldn't reach the Gutenberg catalog right now."),
        h("p", {}, "You can search on ", h("a", { href: url, target: "_blank", rel: "noopener" }, "gutenberg.org"), ", download the EPUB, then import it in your Library.")));
    }
  }
  function draw() {
    results.textContent = "";
    const items = discoverState.results || [];
    if (!items.length) { results.append(h("p", { class: "fine" }, "No books found. Try another spelling or language.")); return; }
    for (const it of items.slice(0, 32)) {
      const authors = (it.authors || []).map((a) => a.name).join("; ");
      const status = h("p", { class: "fine status" });
      const add = h("button", { class: "btn small primary" }, "Add to library");
      add.addEventListener("click", async () => {
        add.disabled = true;
        status.textContent = "Downloading…";
        try {
          const raw = await fetchGutenbergBook(it, (m) => { status.textContent = m; });
          raw.title = raw.title || it.title;
          raw.author = raw.author || authors;
          raw.lang = raw.lang || (it.languages || [])[0];
          const book = finalizeBook(raw);
          const id = await saveNewBook(book, { source: "gutenberg", gutenbergId: it.id });
          status.textContent = "";
          status.append("Added. ", h("a", { href: "#/read/" + encodeURIComponent(id) }, "Start reading"));
          add.textContent = "Added";
        } catch (e) {
          add.disabled = false;
          status.textContent = "";
          if (e.fallback) {
            status.append("Your browser couldn't download it directly. ", h("a", { href: e.fallback, target: "_blank", rel: "noopener" }, "Get the EPUB on Gutenberg"), ", then import it in your Library.");
          } else status.textContent = e.message;
        }
      });
      results.append(h("article", { class: "result card" },
        h("div", { class: "spine sm", style: { background: hueFor(it.title || "") } }, h("span", {}, (it.title || "?").slice(0, 1))),
        h("div", { class: "result-body" },
          h("h3", {}, it.title),
          authors ? h("p", { class: "book-author" }, authors) : null,
          h("p", { class: "fine" }, `${(it.languages || []).map((l) => LANG_NAMES[l] || l).join(", ")} · ${Number(it.download_count || 0).toLocaleString()} downloads`),
          status),
        add));
    }
  }
  if (discoverState.results) draw();
}

// ---------------------------------------------------------------- settings
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; });

async function renderSettings() {
  const wrap = h("div", { class: "wrap narrow" });
  const radio = (name, value, label, current, onchange) =>
    h("label", { class: "radio" }, h("input", { type: "radio", name, value, checked: current === value, onchange }), h("span", {}, label));

  const targetGroup = h("fieldset", { class: "card pad" }, h("legend", {}, "Translate into"),
    h("div", { class: "radios" },
      radio("target", "en", "English", settings.target, () => { settings.target = "en"; saveSettings(); toast("Translating into English"); }),
      radio("target", "tr", "Türkçe (Turkish)", settings.target, () => { settings.target = "tr"; saveSettings(); toast("Türkçeye çevriliyor"); })),
    h("p", { class: "fine" }, "In English, words get dictionary meanings from Wiktionary. In Turkish, words and sentences are machine-translated, with the English meaning shown underneath."));

  const devStatus = h("span", { class: "chip" }, "Checking…");
  onDeviceStatus("de", settings.target).then((s) => {
    devStatus.textContent = s === "missing" ? "Not in this browser" : s === "unavailable" ? "Not available for this language" : s === "unresponsive" ? "Not responding in this browser" : s === "available" ? "Ready" : "Available (downloads once, then works offline)";
  });
  const used = await onlineCharsToday();
  const limit = settings.email ? 50000 : 5000;
  const email = h("input", { type: "email", placeholder: "you@example.com", value: settings.email, "aria-label": "Email for MyMemory" });
  email.addEventListener("change", () => { settings.email = email.value.trim(); saveSettings(); toast(settings.email ? "Daily limit raised to 50,000 characters" : "Email removed"); route(); });
  const engineGroup = h("fieldset", { class: "card pad" }, h("legend", {}, "Translation engine"),
    h("div", { class: "radios" },
      radio("engine", "auto", "Automatic (on-device first, then online)", settings.engine, () => { settings.engine = "auto"; saveSettings(); }),
      radio("engine", "device", "On-device only", settings.engine, () => { settings.engine = "device"; saveSettings(); }),
      radio("engine", "online", "Online only (MyMemory)", settings.engine, () => { settings.engine = "online"; saveSettings(); })),
    h("p", { class: "kv" }, h("span", {}, "On-device translator"), devStatus),
    h("p", { class: "fine" }, "Chrome on a computer (version 138 or newer) can translate on the device for free with no limit. Other browsers use MyMemory, a free online service with a daily limit."),
    h("p", { class: "kv" }, h("span", {}, "Online use today"), h("span", { class: "num" }, `${used.toLocaleString()} of ${limit.toLocaleString()} characters`)),
    h("label", { class: "field" }, h("span", {}, "Email for MyMemory (optional, raises the free limit to 50,000 characters a day)"), email),
    h("p", { class: "fine" }, "Your email is only sent to MyMemory with translation requests. Translations you've already seen are stored on this device and don't count again."),
    h("label", { class: "radio check" },
      h("input", { type: "checkbox", checked: !!settings.autoSentence, onchange: (e) => { settings.autoSentence = e.target.checked; saveSettings(); } }),
      h("span", {}, "Translate the whole sentence automatically when I tap a word")),
    h("p", { class: "fine" }, "Off by default, so tapping words only uses the free online allowance for the word itself. Press “Translate sentence” in the popup when you want the context."));

  const lookGroup = h("fieldset", { class: "card pad" }, h("legend", {}, "Look"),
    h("div", { class: "radios" },
      ["system", "light", "sepia", "dark"].map((t) => radio("theme", t, t[0].toUpperCase() + t.slice(1), settings.theme, () => { settings.theme = t; saveSettings(); }))),
    h("label", { class: "field" }, h("span", {}, "Text size"),
      h("input", { type: "range", min: 15, max: 28, step: 1, value: String(settings.fontSize), oninput: (e) => { settings.fontSize = +e.target.value; saveSettings(); } })));

  const backupIn = h("input", { type: "file", accept: "application/json,.json", class: "visually-hidden", id: "backupIn" });
  backupIn.addEventListener("change", async () => {
    const f = backupIn.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "leselupe") throw new Error("This isn't a Leselupe backup file.");
      for (const store of ["books", "content", "words", "lists", "days"]) if (Array.isArray(data[store])) await db.putMany(store, data[store]);
      toast("Backup restored");
      route();
    } catch (e) { toast(e.message, "error"); }
    backupIn.value = "";
  });
  const dataGroup = h("fieldset", { class: "card pad" }, h("legend", {}, "Your data"),
    h("p", { class: "fine" }, "Books, progress and word lists are stored only in this browser. Make a backup to move them to another device."),
    h("div", { class: "row-actions" },
      h("button", { class: "btn", onclick: async () => {
        const data = { app: "leselupe", version: 1, exportedAt: new Date().toISOString() };
        for (const store of ["books", "content", "words", "lists", "days"]) data[store] = await db.getAll(store);
        download(`leselupe-backup-${today()}.json`, JSON.stringify(data), "application/json");
      } }, "Download backup"),
      backupIn, h("label", { class: "btn", for: "backupIn", tabindex: 0, role: "button", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); backupIn.click(); } } }, "Restore backup"),
      h("button", { class: "btn ghost", onclick: async () => { await db.clear("cache"); toast("Translation cache cleared"); } }, "Clear translation cache")));

  const installBtn = h("button", { class: "btn primary", hidden: !installEvent, onclick: async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    installBtn.hidden = true;
  } }, "Install app");
  const installGroup = h("fieldset", { class: "card pad" }, h("legend", {}, "Use it like an app"),
    installBtn,
    h("p", { class: "fine" }, "iPhone: open this site in Safari, tap Share, then “Add to Home Screen”. Android: open the browser menu and choose “Install app” or “Add to Home screen”."));

  const about = h("section", { class: "card pad about" }, h("h2", {}, "About"),
    h("p", { class: "fine" }, "Leselupe is free and needs no account. Meanings come from Wiktionary (CC BY-SA). Online translations come from MyMemory. Free books come from Project Gutenberg."));

  wrap.append(h("h1", {}, "Settings"), targetGroup, engineGroup, lookGroup, installGroup, dataGroup, about);
  view.append(wrap);
}

// ---------------------------------------------------------------- start
window.addEventListener("hashchange", route);
(async function start() {
  await loadSettings();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  if (!navigator.onLine) toast("You're offline. Your books still open; translations need a connection.");
  route();
})();
