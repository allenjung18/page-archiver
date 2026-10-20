# Architecture

How page-archiver turns a live page into one self-contained HTML file, and what keeps that
file, its folder and the library around it honest. Every statement names the symbol that
implements it (`symbol`, in `path`); when this file and the code disagree, the code is right
and this file is the bug.

## The idea

A page is captured **as rendered**, not as served: it is loaded in a real Chromium, allowed to
run and scrolled, and then its live DOM is frozen. Every resource the frozen DOM uses is taken
from the bytes the browser itself received while the page loaded, inlined as a `data:` URI or
a `<style>`, and every script is removed. What is left needs nothing but the file to render.

Two programs make archives the same way:

- **`pa save`** (Node): `capture` in `packages/core/src/capture.ts` drives Chromium through
  Playwright.
- **The Chrome extension**: `saveTab` in `packages/extension/src/save.ts` captures the tab the
  reader is looking at, signed in as they are.

Both inject the same serializer bundle into every frame and both build the archive with the
same `assemble` (`packages/core/src/assemble.ts`), which imports nothing from Node or Playwright
at run time so the extension's service worker can bundle it (`packages/core/src/portable.ts`).

## Packages

| Package | Runs in | What it holds |
|---|---|---|
| `packages/serializer` | the page | `snapshot()`: the live DOM frozen into an inert clone plus a manifest of resource URLs; bundled to one IIFE, global `PageArchiverSerializer` (`packages/serializer/build.mjs`) |
| `packages/core` | Node (and, through `portable.ts`, the extension) | `capture`, `assemble`, inlining, sanitizing, stamping, the extras, `meta.json`, `importHtml` |
| `packages/library` | Node | the capture folders and `library.db`: `openLibrary` (`library.ts`) |
| `packages/cli` | Node | `pa` (`index.ts`; argument parsing in `args.ts`) |
| `packages/server` | Node | the local API and the reader UI: `startServer` (`index.ts`), `createApp` (`api.ts`), `archiveResponse` (`serve-archive.ts`), the React UI in `ui/` |
| `packages/extension` | Chrome (MV3) | service worker `background.ts`, content script `content.ts`, popup `popup.ts` |

## A capture, step by step (`capture`, `packages/core/src/capture.ts`)

1. **Launch.** `openBrowser` (`browser.ts`): Chromium at `VIEWPORT` 1280x900, device scale 1,
   `bypassCSP: true` (`contextOptions`) so the serializer runs on pages with a strict CSP. A
   `profileDir` gives a persistent, signed-in profile (`launchPersistentContext`); a `browser`
   passed in is reused with a new context.
2. **Record.** `createRecorder` (`recorder.ts`) notes the status and MIME type of every response
   as it arrives and reads bodies lazily, when the archive asks. A body over
   `DEFAULT_RESOURCE_CAP` (25 MB), or past `DEFAULT_TOTAL_CAP` (200 MB) for the page, is not
   used. A lookup is a `hit`, a `miss`, or `unusable` (`Lookup`).
3. **Load and settle.** `page.goto(…, { waitUntil: "load" })` (60 s default, `timeoutMs`), then
   `settle` (`settle.ts`): wait for the network to be idle (`IDLE_QUIET_MS` 500 ms with nothing
   in flight, each wait capped at `IDLE_CAP_MS` 15 s; `trackNetwork`), an optional `waitFor`
   selector, the `dismiss` selectors, then `dismissConsent` (`consent.ts`), which clicks the
   first visible button of `DEFAULT_DISMISS_SELECTORS` in every frame (each consent manager's
   *reject* button is listed before its *accept* button). Then a scroll to the bottom in
   viewport steps (at most `MAX_SCROLL_STEPS`, 60), idle again, back to the top,
   `document.fonts.ready`, and every image decoded (5 s cap). An idle cap that runs out, a
   selector that never came, or a scroll that hit the step limit is a warning.
4. **Poster frames.** `capturePosterFrames` (`posters.ts`) screenshots each visible `<video>`
   in every frame, open shadow roots included (at most `MAX_POSTER_FRAMES`, 20; each frame's
   loading videos get `VIDEO_READY_MS`, 3 s, to show a picture), puts back the scroll position
   of the window and of every box around the video that the screenshot scrolled, and sets the
   PNG on the live element as
   `POSTER_FRAME_ATTRIBUTE`, with the video's own `videoWidth / videoHeight` as
   `VIDEO_RATIO_ATTRIBUTE` (both in `inline/html.ts`). A screenshot, not a canvas, so a
   cross-origin video works too.
5. **Snapshot.** `snapshotFrames` (`frames.ts`) marks each child frame's element with
   `FRAME_ATTRIBUTE`, then evaluates the serializer in every frame, recursively, down to
   `MAX_FRAME_DEPTH` (5); Playwright reaches cross-origin frames from Node. Each frame gives a
   `Snapshot` (`packages/serializer/src/snapshot.ts`): the frozen HTML, `baseUrl`, `url`,
   `title`, a `manifest` of element resource URLs, the page's `fonts` with their load status,
   and `warnings`.
6. **Resolve.** `createResolver` (`resources.ts`) answers each resource from the recorder first;
   a miss (or an unusable recording that can be fetched again) is fetched through
   `page.context().request` with the page's cookies (the `fallback` in `capture`). Results are
   cached. A failure is a warning, never a failed capture.
7. **Assemble.** `assemble` → `buildFrame` (`assemble.ts`) for each frame: `sanitizeDocument`,
   then `inlineDocument` (below), then each captured child frame built the same way and written
   into its `<iframe>` as `srcdoc`. A `<frame>` in a frameset is left empty with a warning.
   Then `sizeWarning` (over `LARGE_ARCHIVE_BYTES`, 50 MB), `summarizeWarnings`, `stamp` and
   `finalizeStamp` (`stamp.ts`).
8. **Extras** (when asked; all of them for a folder, `resolveExtras`): `captureMhtml`
   (`extras/mhtml.ts`, CDP `Page.captureSnapshot`), `screenshotPng` and `printPdf`
   (`extras/shot.ts`; no PDF when headed), and the reader copy, `extractReader` +
   `renderReader` (`extras/reader.ts`, Mozilla Readability over the finished archive, so its
   images are already inlined). An extra that fails is a warning (`attempt`).
9. **Write.** `writeCapture` writes the folder's files with `meta.json` last, after removing an
   earlier capture's files, so a folder with a `meta.json` is complete; or `outFile` gets the
   archive alone.

## What the serializer freezes (`packages/serializer/src/`)

The clone is made in a document from `createHTMLDocument`, which never fetches or runs
anything, walking the live tree and the clone in step (`snapshot.ts`).

- **Styles** (`styles.ts`): a `<style>` whose rules script changed is written from its CSSOM
  (`styleElementText`, `cssomText`); sheets in `adoptedStyleSheets` become `<style>` elements
  marked `ADOPTED_ATTRIBUTE` at the end of their root (`adoptedStyles`); a disabled sheet stays
  off (`sheetDisabled`).
- **Shadow DOM** (`shadow.ts`): open roots become `<template shadowrootmode="open">`
  (`shadowTemplate`); closed roots cannot be read (`openShadowRoot`).
- **Canvas** (`canvas.ts`): `readCanvas` → `canvasToImage`, an `<img>` of the bitmap marked
  `CANVAS_ATTRIBUTE`; a tainted or cleared canvas is a warning (`CanvasResult`).
- **Images** (`images.ts`): `freezeImage` keeps `img.currentSrc` (the candidate the browser
  chose) and drops what would make a reader choose again; an image that never got a URL takes
  the first of `LAZY_SRC_ATTRIBUTES` it has; `collapsePicture` reduces a `<picture>` to its
  `<img>`.
- **State** (`state.ts`): `freezeFormState` writes typed values, checked boxes, chosen options
  and open `<details>` into attributes (never a password's or a file input's value);
  `planScroll` keeps a scrolled box's position.

## Making the document self-contained (`packages/core/src/inline/`)

`inlineDocument` (`inline/html.ts`):

- `<link rel=stylesheet>` becomes a `<style>` of the sheet inlined by `inlineCss`; an alternate
  stylesheet is dropped with a warning; a sheet that cannot be had stays a `<link>` with no
  `href`, its absolute URL set aside (below).
- `<style>` text and `style` attributes have their `url()`s inlined (`inlineUrls`).
- `img src` (with `srcset`, `sizes`, `loading` removed), `input type=image`, `video poster`,
  SVG `<image>`/`<feImage>` `href`, and `background` become `data:` URIs (`inlineAttr`); one that
  cannot be had is set aside and reported.
- **Set aside** (D-516): a resource the capture cannot have (an HTTP error, a cap) never stays a
  live reference, so no archive asks the network for anything, even opened from disk with no CSP.
  An attribute moves to `UNFETCHED_ATTRIBUTE_PREFIX` + its name (`data-page-archiver-unfetched-src`)
  with its absolute URL; a `url()` becomes `UNFETCHED_URL` (`url("data:,")`, which fails to load
  as the fetch did) followed by a `/* page-archiver unfetched: <url> */` comment (`unfetchedNote`),
  and an `@import` becomes a `/* page-archiver unfetched @import: <url> */` comment. Each one's
  warning ends `; set aside`.
- **`<object>` and `<embed>`** (`inlineEmbedded`): an image in one (`object data`, `embed src`,
  by its declared `type` or the response's) becomes an `<img>` of it as a `data:` URI in the
  element's place, keeping its other attributes, so it takes the page's `img` rules. Anything else
  (a document, a PDF, a plugin) is set aside with a warning, its `type` with it: left with a type
  alone, Chromium still starts the plugin. A declared non-image, or an untyped one whose file
  extension is never an image's (`.pdf`, `.swf`, `.html`…), is not fetched. A `data:` URL is
  never put back into the element: there it is a document, which the sanitizer removes.
- **SVG `<use>` of another file** (`inlineUse`), an icon sprite: the element it names, and every
  element that one refers to by `#id` (a gradient, a clip path, another symbol), is copied once
  into a hidden `<svg SPRITES_ATTRIBUTE>` at the end of the `<body>` (or of the shadow root the
  `<use>` is in, where ids are scoped), each id renamed `SPRITE_ID_PREFIX<n>-<id>`, and the
  `<use>` (`href` or `xlink:href`) points at the copy. The sprite is sanitized before anything is
  copied, and what the copies refer to is inlined against the sprite's own URL. A sprite is taken
  in the types Chromium takes it in (SVG or XML), and a plain `href` wins over `xlink:href`. A sprite that
  cannot be had, is not SVG, or has no such element is set aside with a warning.
- Icons: a `<link>` whose `rel` is one of `ICON_RELS` (`icon`, `apple-touch-icon`,
  `apple-touch-icon-precomposed`) is inlined, or removed when it cannot be had.
- **Video and audio** (`freezeMedia`): media files are not archived. The `src` of a `<video>` or
  `<audio>`, and of the `<source>` and `<track>` elements inside it, is moved to
  `MEDIA_SRC_ATTRIBUTE` as an absolute URL (a `data:` source stays where it is) with one warning
  per element. A video's `POSTER_FRAME_ATTRIBUTE` (only a `data:image/png|jpeg|webp` value)
  becomes its `poster`, over the page's own, and a well-formed `VIDEO_RATIO_ATTRIBUTE` becomes
  `aspect-ratio` in its `style`, so the box keeps its height.
- Links (`a`, `area`, `form action`, `formaction`, `cite`, and every other `<link href>`) are
  made absolute (`absoluteLink`, `LINK_ATTRIBUTES`), so they still lead to the live web.

`inlineCss` (`inline/css.ts`) replaces each `@import` by the imported sheet, wrapped in its
`layer`/`supports`/media conditions (`parseImport`), recursively up to `MAX_IMPORT_DEPTH` (16),
with a cycle guard; every `url()` resolves against the sheet's own URL, never the page's
(`resolveCssUrl`). An `@import` or `url()` that cannot be had is set aside (above). CSS that does
not parse keeps its text with `url()`s inlined, and a warning.

Fonts (`inline/fonts.ts`): `createFontFilter` keeps an `@font-face` rule only when the page's
`FontFaceSet` loaded that face (a rule the set does not know is kept); `pruneFontSrc` inlines
only the `src` entry the browser actually fetched.

`toDataUri` (`inline/datauri.ts`) takes the response's MIME type, or sniffs the bytes for the
common image and font signatures when it is missing or generic (`sniffMime`, `effectiveMime`).

## Sanitizing (`packages/core/src/sanitize.ts`)

`sanitizeDocument` removes `REMOVED_ELEMENTS` (`script`, `noscript`, `base`, wherever they
are), `<meta http-equiv>` in `REMOVED_META_HTTP_EQUIV` (the page's CSP, refresh), and `<link>`s
with a `rel` in `REMOVED_LINK_RELS` (fetch hints, the manifest, `serviceworker`, and the
`compression-dictionary`/`dictionary` links Chromium fetches on load). From every element it
strips `on*` attributes, `REMOVED_ATTRIBUTES` (`ping`), any `URL_ATTRIBUTES` value that is a
script URL (`isScriptUrl`), a `data:` document in a frame, embed or object
(`DOCUMENT_URL_ATTRIBUTES`), and SVG animations that would write a script URL; `srcdoc` is
sanitized recursively. `sanitizeHtml` is the same over a string.

## The archive file

- `<meta name="page-archiver:*">` stamps (`STAMP_PREFIX`, `stamp`): source URL, canonical URL
  (`canonicalUrl`), capture time, tool version (`TOOL_VERSION`), the summarized warnings, and a
  sha256 of the file with the hash's own value zeroed (`finalizeStamp`); `verifyStamp` checks
  it, `readStamp` reads the metas back.
- Served and tested under `ARCHIVE_CSP` (`packages/core/src/archive.ts`):
  `default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; frame-src data: about:`.
  Anything left pointing at the network is refused by the browser and seen as a violation.

`meta.json` (`PageMeta`, schema `META_SCHEMA`, `packages/core/src/meta.ts`): id (12 characters
of `[0-9a-z]`, `newPageId`), url, canonicalUrl, title, byline, site, excerpt, lang, capturedAt,
`versionOf`, bytes per file, sha256, tags (`normalizeTags`), tool, warnings.

## Importing (`packages/core/src/import.ts`)

`importHtml` makes a saved HTML file into a capture without fetching anything: sanitized,
stamped, with a reader copy and `meta.json`. The URL and date come from SingleFile's header
comment (`readSingleFileHeader`) or, for a file page-archiver made itself, from its own stamp
(`readOwnStamp`), which outranks a SingleFile comment the page carried (`readSavedHeader`).

## The library (`packages/library/src/`)

- **Where** (`resolveLibraryDir`, `layout.ts`): `--library <dir>`, else `$PA_LIBRARY`
  (`LIBRARY_ENV`), else `~/Archive/pages` (`DEFAULT_LIBRARY_DIR`).
- **Folders** (`captureFolder`): `YYYY/MM/<slug>-<id>/` in the UTC month of capture, `slugify`
  of the title. A folder without `meta.json` is an unfinished capture and is passed over
  (`scanLibrary`, `listCaptureFolders`, `readCaptureFolder`).
- **Index** (`db.ts`): `library.db` (`DB_FILE`), a pages table and an FTS5 table over
  `FTS_COLUMNS` (title, byline, site, text). It is never the record: `rebuildIndex` builds it
  from the folders in place, in one transaction, and `ensureIndex` does so on open when it is
  missing, outdated (`SCHEMA_VERSION`) or unreadable. The indexed text is the reader copy's
  article, or the archive's visible text when there is no reader copy (`readerText`,
  `archiveText`, `text.ts`; capped at `MAX_TEXT`, 2 MB).
- **Search** (`search.ts`): `toFtsQuery` turns words into an FTS5 query (all words, `word*`,
  `"phrases"`, `OR`); `searchPages` and `listPages` take `Filters` (site, tag, since, until,
  all, limit); `findPage` takes an id or a unique prefix.
- **Versions** (`versions.ts`): captures of one URL (`urlKey`: the fragment ignored) are its
  versions, numbered from the captures' URLs and times every time they are read
  (`VERSIONS_VIEW`, `versionsOf`, `previousVersion`), so a rebuilt index numbers them the same.
- **Writes** (`openLibrary`, `library.ts`): `add` writes the folder first (`writeCapture`), then
  indexes it; `tag` writes `meta.json` first (`writeAtomic`), then the index; `remove` renames
  the folder to a dot-name the scan never reads (one step), drops its rows, then deletes it.

## The server (`packages/server/src/`)

`startServer` (`index.ts`) listens on `DEFAULT_HOST` (`127.0.0.1`) only, on `DEFAULT_PORT`
(47320) unless told otherwise, with a write token of 24 random bytes in hex (`newToken`).
`createApp` (`api.ts`) refuses any request whose `Host` is not `127.0.0.1:<port>` or
`localhost:<port>`, and every write needs `Authorization: Bearer <token>`. The reader UI is
served under `UI_CSP`. Archives are served by `archiveResponse` (`serve-archive.ts`) with
`ARCHIVE_HEADERS` (`ARCHIVE_CSP`, `nosniff`, `no-referrer`, `no-store`) at
`/archive/<id>/original|reader` (`VIEWS`), and the UI shows them only in an
`<iframe sandbox="">` (`App`, `ui/src/App.tsx`).

## The extension (`packages/extension/src/`)

`saveTab` (`save.ts`): `snapshotTab` injects `CONTENT_FILES` (the serializer IIFE and
`content.ts`) into every frame; `createContentApi` (`content.ts`) marks child frames
(`FRAME_ATTRIBUTE`) and snapshots each frame; `buildTree` (`tree.ts`) rebuilds the frame tree;
`fetchResource` fetches each resource from the service worker (host permission for every site,
so no CORS, with the reader's cookies); core's `assemble` builds the archive, with
`node:crypto` replaced by a plain SHA-256 (`shims/node-crypto.ts`, `sha256.ts`). `deliver`
(`server.ts`) posts it to `pa serve` at the address in the popup (`DEFAULT_SERVER`), pairing by
reading the token from the UI page (`tokenFromPage`) and waiting at most `ANSWER_TIMEOUT_MS`
(120 s); when the server is not there, the archive is downloaded instead (`downloadName`).
The extension makes no poster frames: a video saved from Chrome keeps its own poster, or none.

## Limits, as built

- Closed shadow roots, `<frame>`s in a frameset, frames deeper than five, tainted canvases and
  video or audio files are not archived; each one is a warning.
- A resource the site will not give again (an HTTP error, a cap) is not in the archive: it is
  set aside, so an archive opened online does not show it either. The warning and the set-aside
  attribute or comment name the URL.
- The reader copy needs Readability to find an article; a page without one gets none.
