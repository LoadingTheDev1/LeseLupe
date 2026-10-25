// Text helpers: words, sentences, language guess.

export const WORD_RE = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu;

export function countWords(s) {
  const m = s.match(WORD_RE);
  return m ? m.length : 0;
}

// The word that contains `offset` in `text`, or null.
export function wordAt(text, offset) {
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) {
    const start = m.index, end = start + m[0].length;
    if (offset >= start && offset <= end) {
      // a tap exactly on the gap after a word belongs to that word only if it touches it
      if (offset === end && end < text.length && /[\p{L}\p{M}]/u.test(text[end])) continue;
      return { word: m[0], start, end };
    }
    if (start > offset) break;
  }
  return null;
}

const ABBREV = new Set([
  "dr", "prof", "nr", "kap", "ca", "bzw", "usw", "vgl", "z", "b", "d", "h", "u", "a", "s", "st", "hr", "fr",
  "mr", "mrs", "ms", "jr", "sr", "vs", "etc", "e", "g", "i", "no", "p", "pp", "ch", "abs", "art", "bd", "evtl",
  "ggf", "inkl", "jh", "mio", "mrd", "o", "sog", "tel", "v", "chr", "m", "mme", "mlle", "sra", "sr", "dott", "sig",
]);

// Split a paragraph into sentence spans [{start, end}].
export function sentenceSpans(text) {
  const spans = [];
  const re = /[.!?…]+["“”»«'’)\]]*(?=\s|$)/g;
  let start = 0, m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const before = text.slice(start, m.index);
    const lastTok = (before.match(/([\p{L}\d]+)$/u) || [, ""])[1];
    const isDot = m[0][0] === "." && m[0].length === 1;
    if (isDot) {
      if (ABBREV.has(lastTok.toLowerCase())) continue;
      if (/^\d+$/.test(lastTok)) {
        // "3. November" / "Kapitel 3." – an ordinal, unless the next word starts a new sentence after a closing quote
        const next = text.slice(end).match(/^\s+(\S)/u);
        if (next && /[\p{Ll}\d]/u.test(next[1])) continue;
        if (next && /\p{Lu}/u.test(next[1]) && lastTok.length <= 2) continue;
      }
      if (/^\p{Lu}$/u.test(lastTok)) continue; // initials like "J. S. Bach"
    }
    const next = text.slice(end).match(/^\s+(\S)/u);
    if (next && /\p{Ll}/u.test(next[1])) continue; // lowercase after punctuation: not a new sentence
    spans.push({ start, end });
    start = end;
    while (start < text.length && /\s/.test(text[start])) start++;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

export function sentenceAt(text, offset) {
  const spans = sentenceSpans(text);
  for (const s of spans) if (offset >= s.start && offset <= s.end) return { ...s, text: text.slice(s.start, s.end).trim() };
  return { start: 0, end: text.length, text: text.trim() };
}

const STOP = {
  de: "der die das und ist nicht ein eine ich sie er es mit sich auf für dem den des zu von im auch als wie aber wir noch nur so wenn hat war",
  en: "the and of to is in that it was he for on are as with his they at be this have from or one had by but not what all were",
  fr: "le la les et est des une un du que qui dans en pour pas sur au avec il elle ne se ce sont plus par mais nous vous",
  es: "el la los las y es en que de del un una por con para no se su al lo como más pero sus le ya o fue este ha",
  it: "il la le e è di che un una per non con del della sono si gli da in al lo ma come anche più nel ha",
  tr: "ve bir bu da de için ile çok ne ama olarak gibi daha o en kadar sonra şey her ben sen değil var yok mi mı",
  nl: "de het een en van is dat niet in op te zijn met voor er die als maar ook ik je hij zij wat aan om",
  pt: "o a os as e é de que um uma para com não do da em no na por se mais mas como ao foi",
  pl: "i w nie na że się to jest z do o jak ale co po tak za od jego tylko przez",
  sv: "och att det som en på är av för med den till inte har de om ett var jag men",
};
const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(" "))]));

export function guessLanguage(sample) {
  const words = (sample.toLowerCase().match(WORD_RE) || []).slice(0, 4000);
  let best = "de", bestScore = -1;
  for (const [lang, set] of Object.entries(STOPSETS)) {
    let n = 0;
    for (const w of words) if (set.has(w)) n++;
    if (n > bestScore) { best = lang; bestScore = n; }
  }
  return best;
}

export function normalizeSpace(s) {
  return s.replace(/­/g, "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
}
