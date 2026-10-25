// Free, legal books from Project Gutenberg (public domain), via the Gutendex catalog API.
import { parseEpub, parseTxt } from "./importers.js";

export async function searchGutenberg(query, lang, page = 1) {
  const url = new URL("https://gutendex.com/books/");
  if (query) url.searchParams.set("search", query);
  if (lang) url.searchParams.set("languages", lang);
  if (page > 1) url.searchParams.set("page", String(page));
  const res = await fetch(url);
  if (!res.ok) throw new Error("The Gutenberg catalog didn't answer.");
  return res.json();
}

export function bookPage(id) {
  return `https://www.gutenberg.org/ebooks/${id}`;
}

function pickFormats(formats) {
  const keys = Object.keys(formats || {});
  const epub = keys.find((k) => k.startsWith("application/epub"));
  const txt = keys.find((k) => k.startsWith("text/plain") && /utf-8/i.test(k)) || keys.find((k) => k.startsWith("text/plain"));
  return { epub: epub && formats[epub], txt: txt && formats[txt] };
}

// Download and parse a Gutenberg book. Throws {fallback: url} when the browser can't fetch it directly.
export async function fetchGutenbergBook(item, onProgress = () => {}) {
  const f = pickFormats(item.formats);
  const attempts = [];
  if (f.epub) attempts.push(["epub", f.epub]);
  if (f.txt) attempts.push(["txt", f.txt]);
  for (const [kind, url] of attempts) {
    try {
      onProgress(`Downloading ${kind.toUpperCase()}…`);
      const res = await fetch(url);
      if (!res.ok) continue;
      if (kind === "epub") return await parseEpub(await res.arrayBuffer(), onProgress);
      return parseTxt(await res.text());
    } catch (e) {
      /* try the next format */
    }
  }
  const err = new Error("Your browser couldn't download this book directly.");
  err.fallback = bookPage(item.id);
  throw err;
}
