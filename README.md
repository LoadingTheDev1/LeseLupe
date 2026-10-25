# Leselupe

A free reader for books in another language. Tap any word to see its meaning, tap a sentence to translate it, save words to lists and see how much you've read. It works in any modern browser and can be added to a phone's home screen like an app. There's no account, no server and no cost.

## Features

- **Import books**: EPUB, PDF (with a text layer) and TXT. You can also drag files onto the page.
- **Free books**: search Project Gutenberg's public-domain catalog and add a book with one tap.
- **Tap a word**: you get the base form (for example *Fensterläden → Fensterladen*), the part of speech, its meanings, and a *Translate sentence* button that translates the whole sentence so you see it in context.
- **Tap a sentence**: switch the reader from *Word* to *Sentence* mode. You can also select any phrase and press *Translate selection*.
- **English or Turkish**: translations are in English by default; switch to Turkish any time in Settings.
- **Word lists**: save words together with their sentence, sort them into your own lists, search them and export them as CSV (this works with Anki and spreadsheets).
- **Reading stats**: progress per book, time spent reading, a daily streak, a 14-day chart, words read and books finished.
- **Reading comfort**: light, sepia and dark themes, adjustable text size and line spacing, read-aloud, and chapter navigation.
- **Works offline**: the app and your books stay on the device. Only translations need the internet.
- **Backup**: download one file and restore it on another device.

## Host your own copy

The site is plain files with no build step, published with GitHub Pages. It must be served over **https**. Opening `index.html` straight from your disk won't work, because browsers block modules on `file://`.

1. Fork this repository, or create a new public one and upload these files (`index.html` must be at the top level).
2. Go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, then `main` / `root`.
3. After a minute the site is live at `https://<your-name>.github.io/<repo>/`.

**Try it locally:** run `python3 -m http.server 8000` inside the folder, then open http://localhost:8000.

## Install on a phone

- **iPhone**: open the site in Safari, tap *Share*, then *Add to Home Screen*.
- **Android**: open it in Chrome, open the ⋮ menu, then *Install app* (or *Add to Home screen*).

## Where translations come from (all free)

| What | Service | Limits |
|---|---|---|
| Word meanings, base forms | [Wiktionary](https://en.wiktionary.org) REST API | Free. Text is CC BY-SA. |
| Words and sentences, on the device | Chrome's built-in Translator (desktop Chrome 138+) | Free, no limit, works offline after a one-time language download. |
| Words and sentences, online | [MyMemory](https://mymemory.translated.net) | About 5,000 characters a day per user. Adding an email in Settings raises this to about 50,000 (see Privacy). |

Every translation is cached on the device, so looking something up again costs nothing. The app tries the on-device translator first. If the browser doesn't have one, it uses MyMemory. To make the allowance last, tapping a word only translates the word; the sentence is translated when you press *Translate sentence* in the popup. You can make that automatic in Settings.

Machine translation is not perfect. Idioms and literary style are sometimes translated too literally, and Wiktionary is strongest for English meanings. For Turkish, the app shows the machine translation with the English dictionary meaning under it.

## Privacy

Books, progress, word lists and settings are stored only in the browser's own storage (IndexedDB) on the device. Nothing is uploaded anywhere. The only data that leaves the device is the word or sentence being translated (sent to Wiktionary or MyMemory) and Gutenberg searches.

**About the optional email:** if you enter an email in Settings, it is sent to MyMemory, a separate service run by Translated, with every online translation request, so they can give you the higher free limit. Leselupe isn't affiliated with MyMemory, and their privacy policy covers how they use it. The email is stored only in your browser and goes nowhere else. Leave the box empty to translate anonymously. Clearing the browser's site data deletes everything, so use *Settings → Download backup* from time to time.

## Updating the site

After changing files, change `VERSION` at the top of `sw.js` (for example `leselupe-v2`) so installed copies refresh their offline cache.

## Files

```
index.html             page shell
css/app.css            all styles (themes, layout)
js/app.js              screens: library, reader, words, stats, free books, settings
js/importers.js        EPUB / PDF / TXT → paragraphs and chapters
js/translate.js        Chrome on-device translator, MyMemory, Wiktionary, cache
js/gutenberg.js        Project Gutenberg search and download (via gutendex.com)
js/text.js             word and sentence detection, language guess
js/db.js               on-device storage
js/sample.js           a short original German story to try the app
sw.js                  offline support
manifest.webmanifest   app name and icons for home-screen install
vendor/                JSZip (EPUB) and pdf.js (PDF)
fonts/                 Literata and IBM Plex Sans
```

## Credits and licences

- [pdf.js](https://mozilla.github.io/pdf.js/) by Mozilla: Apache License 2.0 (`vendor/LICENSE-pdfjs.txt`)
- [JSZip](https://stuk.github.io/jszip/): MIT or GPLv3 (`vendor/LICENSE-jszip.md`)
- [Literata](https://github.com/googlefonts/literata) and [IBM Plex Sans](https://github.com/IBM/plex): SIL Open Font License 1.1 (`fonts/`)
- Word meanings: [Wiktionary](https://en.wiktionary.org), CC BY-SA 4.0
- Online translation: [MyMemory](https://mymemory.translated.net) by Translated
- Free books: [Project Gutenberg](https://www.gutenberg.org) through [Gutendex](https://gutendex.com)

Only import books you have the right to read in this way. Project Gutenberg books are public domain in the USA. Check the rules in your own country.
