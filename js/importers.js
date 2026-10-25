// Turn EPUB, PDF and TXT files into a list of blocks: [{h: 0|1, s: "text"}].
import { guessLanguage, normalizeSpace } from "./text.js";

const HEADING_ALT = /^(?:[\p{L}\d]+\.?\s+)?(?:kapitel|chapter|teil|part|buch|book|abschnitt|bölüm|chapitre|capítulo|capitolo|hoofdstuk)(?:\s+[\p{L}\d]+\.?)?$/iu;
function looksLikeHeading(s) {
  return s.length < 70 && (HEADING_WORD.test(s) && !/[.!?,;:]$/.test(s.replace(/^\S+\s+[\dIVXLC]+\.$/, "x")) || HEADING_ALT.test(s));
}
const HEADING_WORD = /^(kapitel|chapter|teil|part|buch|book|abschnitt|section|capítulo|capitulo|chapitre|capitolo|hoofdstuk|bölüm|rozdział|kapitlet|prolog|prologue|epilog|epilogue|vorwort|nachwort|einleitung|preface|introduction)\b/i;

export async function importFile(file, onProgress = () => {}) {
  const name = file.name || "Untitled";
  const ext = (name.split(".").pop() || "").toLowerCase();
  let book;
  if (ext === "epub" || file.type === "application/epub+zip") {
    book = await parseEpub(await file.arrayBuffer(), onProgress);
  } else if (ext === "pdf" || file.type === "application/pdf") {
    book = await parsePdf(await file.arrayBuffer(), onProgress);
  } else if (ext === "txt" || ext === "text" || file.type.startsWith("text/")) {
    book = parseTxt(await file.text());
  } else {
    throw new Error("This file type isn't supported. Use an EPUB, PDF or TXT file.");
  }
  if (!book.title) book.title = name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ");
  return finalizeBook(book);
}

export function finalizeBook(book) {
  let blocks = book.blocks.filter((b) => b.s && b.s.trim());
  blocks = stripGutenbergBoilerplate(blocks);
  if (!blocks.length) throw new Error("No readable text was found in this file.");
  const sample = blocks.slice(0, 300).map((b) => b.s).join(" ");
  const lang = normalizeLang(book.lang) || guessLanguage(sample);
  return { title: (book.title || "Untitled").trim(), author: (book.author || "").trim(), lang, blocks };
}

function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(c) ? c : null;
}

function stripGutenbergBoilerplate(blocks) {
  const startIdx = blocks.findIndex((b) => /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(b.s));
  if (startIdx >= 0) blocks = blocks.slice(startIdx + 1);
  const endIdx = blocks.findIndex((b) => /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(b.s));
  if (endIdx >= 0) blocks = blocks.slice(0, endIdx);
  return blocks;
}

// ---------- TXT ----------
export function parseTxt(raw) {
  let text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let title = "", author = "", lang = "";
  const head = text.slice(0, 3000);
  const t = head.match(/^Title:\s*(.+)$/m);
  const a = head.match(/^Author:\s*(.+)$/m);
  const l = head.match(/^Language:\s*(.+)$/m);
  if (t) title = t[1].trim();
  if (a) author = a[1].trim();
  if (l) lang = { german: "de", english: "en", french: "fr", spanish: "es", italian: "it", dutch: "nl", turkish: "tr", portuguese: "pt" }[l[1].trim().toLowerCase()] || "";
  const startMatch = text.match(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (startMatch) text = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = text.match(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (endMatch) text = text.slice(0, endMatch.index);

  const paras = text.split(/\n\s*\n+/);
  const blocks = [];
  for (const p of paras) {
    const lines = p.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!lines.length) continue;
    const joined = lines.reduce((acc, line) => {
      if (!acc) return line;
      if (/[\p{L}]-$/u.test(acc) && /^\p{Ll}/u.test(line)) return acc.slice(0, -1) + line;
      return acc + " " + line;
    }, "");
    const s = normalizeSpace(joined);
    blocks.push({ h: isHeading(s, lines.length) ? 1 : 0, s });
  }
  if (!title && blocks.length && blocks[0].h) title = blocks[0].s;
  return { title, author, lang, blocks };
}

function isHeading(s, lineCount) {
  if (lineCount > 2 || s.length > 70) return false;
  if (HEADING_WORD.test(s) || HEADING_ALT.test(s)) return true;
  if (/^[IVXLC]+\.?$/.test(s) || /^\d{1,3}\.?$/.test(s)) return true;
  if (/[.!?,;:]$/.test(s)) return false;
  const letters = s.replace(/[^\p{L}]/gu, "");
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

// ---------- EPUB ----------
export async function parseEpub(buf, onProgress = () => {}) {
  if (!globalThis.JSZip) throw new Error("The EPUB reader didn't load. Check your connection and reload.");
  const zip = await JSZip.loadAsync(buf);
  const containerXml = await readZipText(zip, "META-INF/container.xml");
  if (!containerXml) throw new Error("This EPUB is missing its table of contents file.");
  const container = parseXml(containerXml);
  const rootPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootPath) throw new Error("This EPUB is damaged (no rootfile).");
  const opf = parseXml(await readZipText(zip, rootPath));
  const base = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/") + 1) : "";
  const meta = (tag) => {
    const el = opf.getElementsByTagNameNS("*", tag)[0];
    return el ? el.textContent.trim() : "";
  };
  const title = meta("title"), author = meta("creator"), lang = meta("language");
  const manifest = {};
  for (const item of opf.getElementsByTagNameNS("*", "item")) {
    manifest[item.getAttribute("id")] = { href: item.getAttribute("href"), type: item.getAttribute("media-type") || "" };
  }
  const spine = [...opf.getElementsByTagNameNS("*", "itemref")]
    .filter((r) => r.getAttribute("linear") !== "no")
    .map((r) => manifest[r.getAttribute("idref")])
    .filter((m) => m && /html|xml/.test(m.type));
  const blocks = [];
  for (let i = 0; i < spine.length; i++) {
    onProgress(`Reading chapter ${i + 1} of ${spine.length}`);
    const path = resolvePath(base, spine[i].href);
    const html = await readZipText(zip, path);
    if (!html) continue;
    let doc = new DOMParser().parseFromString(html, "application/xhtml+xml");
    if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body || doc.getElementsByTagName("body")[0];
    if (body) collectBlocks(body, blocks);
  }
  return { title, author, lang, blocks };
}

async function readZipText(zip, path) {
  const f = zip.file(path) || zip.file(decodeURIComponent(path));
  return f ? f.async("string") : null;
}
function parseXml(s) {
  return new DOMParser().parseFromString(s || "", "application/xml");
}
function resolvePath(base, href) {
  const clean = href.split("#")[0];
  const parts = (base + clean).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

const LEAF = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "dt", "dd", "figcaption", "td", "th"]);
const SKIP = new Set(["script", "style", "nav", "head", "svg", "math", "img", "audio", "video"]);
const BLOCKY = new Set(["div", "section", "article", "blockquote", "main", "aside", "header", "footer", "body", "ul", "ol", "dl", "table", "tbody", "thead", "tr", "figure", "center"]);

function collectBlocks(el, out) {
  for (const child of el.children) {
    const tag = child.localName ? child.localName.toLowerCase() : "";
    if (SKIP.has(tag)) continue;
    if (child.getAttribute && /pagenum|page-?number/i.test(child.getAttribute("class") || "")) continue;
    if (LEAF.has(tag)) {
      const s = normalizeSpace(child.textContent || "");
      if (s) out.push({ h: /^h[1-4]$/.test(tag) ? 1 : 0, s });
    } else if (BLOCKY.has(tag)) {
      const hasBlockKids = [...child.children].some((c) => {
        const t = c.localName ? c.localName.toLowerCase() : "";
        return LEAF.has(t) || BLOCKY.has(t);
      });
      if (hasBlockKids) collectBlocks(child, out);
      else {
        const s = normalizeSpace(child.textContent || "");
        if (s) out.push({ h: 0, s });
      }
    } else {
      // inline element directly inside a container: treat as its own small paragraph
      const s = normalizeSpace(child.textContent || "");
      if (s && s.length > 1) out.push({ h: 0, s });
    }
  }
}

// ---------- PDF ----------
export async function parsePdf(buf, onProgress = () => {}) {
  const pdfjs = await import("../vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let title = "", author = "";
  try {
    const meta = await doc.getMetadata();
    title = meta?.info?.Title || "";
    author = meta?.info?.Author || "";
  } catch (e) { /* metadata is optional */ }

  const lines = []; // {s, y, h, page, x}
  let totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress(`Reading page ${p} of ${doc.numPages}`);
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let cur = null;
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      const y = it.transform[5], x = it.transform[4], h = Math.abs(it.transform[3]) || it.height || 10;
      if (!cur || Math.abs(cur.y - y) > h * 0.5) {
        if (cur && cur.s.trim()) lines.push(cur);
        cur = { s: "", y, x, h, page: p };
      }
      cur.s += it.str;
      if (it.hasEOL) {
        if (cur.s.trim()) lines.push(cur);
        cur = null;
      }
    }
    if (cur && cur.s.trim()) lines.push(cur);
    totalChars += tc.items.reduce((n, it) => n + (it.str ? it.str.length : 0), 0);
    page.cleanup();
  }
  if (totalChars < 20 * Math.max(1, doc.numPages) * 0.1) {
    throw new Error("This PDF has no text layer (it's scanned images), so words can't be tapped. Try an EPUB or a text PDF.");
  }

  // Page numbers and running headers sit at the top or bottom edge of a page, at the same height on many pages.
  const byPage = new Map();
  lines.forEach((l, i) => { if (!byPage.has(l.page)) byPage.set(l.page, []); byPage.get(l.page).push(i); });
  const edge = new Set();
  for (const idxs of byPage.values()) {
    const sorted = [...idxs].sort((a, b) => lines[b].y - lines[a].y);
    sorted.slice(0, 2).forEach((i) => edge.add(i));
    sorted.slice(-2).forEach((i) => edge.add(i));
  }
  const edgeKey = (l) => l.s.trim().replace(/\d+/g, "#") + "@" + Math.round(l.y / 6);
  const freq = new Map();
  lines.forEach((l, i) => { if (edge.has(i)) freq.set(edgeKey(l), (freq.get(edgeKey(l)) || 0) + 1); });
  const pages = doc.numPages;
  const clean = lines.filter((l, i) => {
    if (!edge.has(i)) return true;
    const s = l.s.trim();
    if (/^[-–—\s]*(\d{1,4}|[ivxlc]{1,7})[-–—\s]*$/i.test(s)) return false;
    return !(pages >= 3 && s.length < 90 && freq.get(edgeKey(l)) >= Math.max(3, pages * 0.3));
  });

  // typical line spacing, length and font size
  const gaps = [];
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].page === clean[i - 1].page) {
      const g = clean[i - 1].y - clean[i].y;
      if (g > 0 && g < 60) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
  const lens = clean.map((l) => l.s.trim().length).sort((a, b) => a - b);
  const typicalLen = lens.length ? lens[Math.floor(lens.length * 0.7)] : 60;
  const xs = clean.map((l) => l.x).sort((a, b) => a - b);
  const leftX = xs.length ? xs[Math.floor(xs.length * 0.2)] : 0;
  const sizes = clean.map((l) => l.h).sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
  const isHead = (l) => {
    const s = l.s.trim();
    if (s.length > 90 || /[,;]$/.test(s)) return false;
    if (l.h >= bodySize * 1.12 && /\p{L}/u.test(s) && !/[.:]$/.test(s.replace(/\b[\dIVXLC]+\.$/, ""))) return true;
    return looksLikeHeading(s) && s.length < typicalLen * 0.8;
  };

  const blocks = [];
  let para = "";
  let lastHead = null;
  const flush = () => {
    const s = normalizeSpace(para);
    if (s) blocks.push({ h: 0, s });
    para = "";
  };
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i], s = l.s.trim();
    const prev = clean[i - 1];
    if (isHead(l)) {
      flush();
      // a heading that wraps onto a second line belongs to the same heading
      if (lastHead && prev === lastHead.line && prev.page === l.page && prev.y - l.y < l.h * 2) {
        lastHead.block.s = normalizeSpace(lastHead.block.s + " " + s);
      } else {
        const block = { h: 1, s: normalizeSpace(s) };
        blocks.push(block);
        lastHead = { block, line: l };
      }
      lastHead.line = l;
      continue;
    }
    let newPara = false;
    if (prev && !(lastHead && prev === lastHead.line)) {
      const samePage = prev.page === l.page;
      const gap = samePage ? prev.y - l.y : lineGap;
      const prevS = prev.s.trim();
      const prevShort = prevS.length < typicalLen * 0.7 && /[.!?:»«“”"’)]$/.test(prevS);
      const indented = l.x > leftX + 8;
      if (samePage && gap > lineGap * 1.45) newPara = true;
      else if (prevShort) newPara = true;
      else if (indented && /[.!?:»«“”"’)]$/.test(prevS)) newPara = true;
    }
    if (newPara) flush();
    if (!para) para = s;
    else if (/[\p{L}]-$/u.test(para) && /^\p{Ll}/u.test(s)) para = para.slice(0, -1) + s;
    else para += " " + s;
  }
  flush();
  return { title, author, lang: "", blocks };
}

// ---------- book structure ----------
// Split blocks into readable sections (chapters, or chunks of at most MAX blocks).
export function buildSections(blocks) {
  const MAX = 140;
  const secs = [];
  let cur = null;
  blocks.forEach((b, i) => {
    const tooLong = cur && i - cur.start >= MAX && !b.h;
    if (b.h || !cur || tooLong) {
      if (cur) { cur.end = i; secs.push(cur); }
      const base = b.h ? b.s : cur ? cur.baseTitle : "Beginning";
      const n = tooLong ? (cur.part || 1) + 1 : 1;
      cur = { start: i, baseTitle: base, part: n, title: n > 1 ? `${base} (${n})` : base };
    }
  });
  if (cur) { cur.end = blocks.length; secs.push(cur); }
  // merge tiny sections (title pages, stacked headings) into the next one
  const merged = [];
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i];
    if (s.end - s.start < 3 && i < secs.length - 1) {
      secs[i + 1].start = s.start;
      continue;
    }
    merged.push(s);
  }
  return merged.map((s) => ({ title: shorten(s.title, 80), start: s.start, end: s.end }));
}
function shorten(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
