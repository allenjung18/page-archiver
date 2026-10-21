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
   An `<iframe>` that was not captured (nested deeper than `MAX_FRAME_DEPTH`, not located, or
   never loaded) is left empty: its `src` is removed, and its own `srcdoc`, which is sanitized
   but never inlined, is set aside into `data-page-archiver-unfetched-srcdoc`, so its images and
   sheets are not fetched from the live site when the file is opened from disk. One too deep or
   that failed is warned for by `snapshotFrames` (`; left empty`); an unmarked one (not located,
   never loaded) is warned for here, `; left empty`, with `, its srcdoc set aside` when it had one.
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
- `<style>` text and `style` attributes have their `url()`s, and the string arguments of
  `image-set()` and `-webkit-image-set()`, inlined (`inlineUrls`). A function's name is read as
  Chromium reads it, its CSS escapes decoded (`urlTokens`, `imageSetStrings`): `\75rl(`, `u\72l(`
  and `\55 RL(` are `url(`s and `image-s\65t(` is an `image-set(`, in a sheet, a `style`
  attribute, a font's `src` list and an SVG attribute alike. A `url()` and a string are read as
  the CSS tokenizer reads them (`urlAt`, `stringAt`), which is how Chromium reads them: the end of
  the text closes an open `url(` or string (a `style` attribute, or a `<style>` postcss cannot
  parse, may end inside one); a backslash before a newline in a string is a line continuation;
  comments between a `url()`'s string and its `)` are skipped; and only space, tab, LF, CR and FF
  are whitespace, so a no-break or ideographic space is part of an unquoted `url()`. A bad url (a
  quote or a broken escape in an unquoted one) and a bad string (a newline in one) fetch nothing
  and are left as they came. Comments, strings and a bad url's remnants are read past as the
  tokenizer reads them, so a `url(` or a quote in one is not a `url()` and hides nothing after it.
  `parseImport` and the `setImportsAside` fallback read an `@import`'s URL the same way.
- A string in a custom property (`--u: "a.png"`, or an `@property`'s `initial-value`) is fetched
  as a `url()` is when `var()` brings it into an `image-set()` (`image-set(var(--u) 1x)`). So is
  one written inside a substitution function in an `image-set()` (scanImageSet's `substituted`):
  a `var()`, `env()`, `attr()` or `inherit()` fallback (`image-set(var(--nope, "a.png") 1x)`,
  nested too), an `if()` branch, a custom function's argument (`image-set(--pass("a.png") 1x)`),
  and an `@function`'s `result` or a default in its prelude, which `image-set(--img() 1x)` brings
  in. So is a string directly in a custom function's call anywhere in a value (or in a `var()`
  fallback in one), `background-image: --wrap("a.png")`, since its result may put it in an
  `image-set()`; a string in a `type()` or an `if()`'s `style()` condition is not one. An `@property` and an
  `@function` are known by their at-rule's name and a descriptor by its name, escapes decoded as
  Chromium decodes them (`@p\72operty`, which postcss names `p`; `@\70roperty`, which postcss
  cannot parse; `initial-v\61lue`), and in a sheet postcss cannot parse the reader tracks which
  at-rule's block it is in. Each such string is inlined too (`inlineCustomPropertyStrings`,
  `customPropertyStrings` and its `StringScope`), in a sheet, a `style` attribute and a sheet
  postcss cannot parse, but
  only when its URL, resolved against the sheet it is written in, is one the browser asked for
  while the page loaded: an image it fetched (`ctx.fetched`, and an image type, since `"/"` or
  `"app.css"` names the page or a sheet the browser did fetch) becomes a `data:` URI string, and
  one it asked for whose bytes cannot be had (`ctx.requested`: an HTTP error live, or a cap)
  becomes `"data:"` and a comment with its URL. Any other string is kept as written: a custom
  property holds font names and `content` text as often as images, a fallback or an `if()` branch
  may never be the value, and only the browser's fetch tells them apart. `capture()` (the CLI and the server) passes `fetched` from the recorder (a 2xx
  response) and `requested` from it too (any response). The extension passes `fetched` from each
  frame's resource timing entries, which hold an HTTP error too (its own fetch of one then fails
  and sets it aside); that buffer keeps 250 entries unless a page enlarges it, and a page can
  clear it, so on a page past 250 resources an image loaded after it filled is not seen and its
  string is kept as written. A caller that passes no `fetched` (`inlineDocument` or `inlineCss`
  called directly) keeps every such string as written. So an image a custom property, a fallback
  or an `if()` branch names that the page did not load (one used only on `:hover`, a branch the
  page did not take) stays a live URL, and an archive opened from disk with no CSP fetches it if
  that value ever applies; served by the library, the CSP refuses it.
- `img src` (with `srcset`, `sizes`, `loading` removed), `input type=image`, `video poster`,
  SVG `<image>`/`<feImage>` `href`, and `background` become `data:` URIs (`inlineAttr`); one that
  cannot be had is set aside and reported.
- **Set aside** (D-516): a resource the capture cannot have (an HTTP error, a cap) never stays a
  live reference, so an archive opened from disk with no CSP asks the network for nothing the page
  loaded (the one live URL that can remain is a string a substitution may bring into an
  `image-set()`, a custom property's, a fallback's or an `if()` branch's, that the page never
  fetched, above).
  That holds for `<object>`, `<embed>`, SVG `<use>`, SVG `url()` attributes, an SVG `cursor` and
  the values an SVG `<set>` or `<animate>` writes into any of those URL attributes too (below), and for
  a `url()` or `image-set()` whose name is written with CSS escapes or that is written in any shape
  the tokenizer reads (left open at the end, continued over a line, a comment before its `)`, a
  no-break space in it): each one's file is inlined or set aside, never left as a URL. An uncaptured frame's `srcdoc` is set
  aside whole (Assemble, above).
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
- **SVG `url()` attributes that name another file** (`inlineSvgRef`, `SVG_REF_ATTRIBUTES`): a
  `filter`, `mask`, `clip-path`, `marker-start`/`-mid`/`-end`, `fill` or `stroke` of an SVG element
  whose `url()` names an element in another file (`url(fx.svg#blur)`) has that element copied in
  as a `<use>`'s is, and the `url()` points at the copy. A `url()` naming the page itself (by its
  own URL, `pageUrl`, not its `<base>`) points at the page's own element (`url(#id)`). One that cannot be had is set aside with a warning: its
  URL in `data-page-archiver-unfetched-<name>`, the attribute left as the failed reference renders
  (a `fill` or `stroke` keeps its fallback colour, else `none`). A string in an `image-set()`
  in a `mask` names an image, not an element (`mask="image-set('m.png' 1x)"` is a mask image, as is the
  same value a `<set attributeName="mask">` writes): it is inlined as a `data:` URI as a `style`
  attribute's is, or, when it cannot be had, becomes `UNFETCHED_URL` (the mask is not made `none`)
  with its URL in `data-page-archiver-unfetched-<name>`.
- **SVG `url()` attributes that name an image** (`inlineSvgImageAttr`, `SVG_IMAGE_ATTRIBUTES`): an
  SVG element's `cursor` (`url(cur.png) 4 4, auto`) has each `url()` inlined as a `data:` URI, as a
  `style` attribute's are, never copied in as an element. One that cannot be had becomes
  `UNFETCHED_URL`, so the cursor passes to the next as it did live, its URL in
  `data-page-archiver-unfetched-cursor`.
- **SVG animations that write a URL attribute** (`inlineAnimation`, `ANIMATION_ELEMENTS`): a
  `<set>` or `<animate>` runs again when the archive opens, so when its `attributeName` is an
  `href` (`xlink:href` too) or one of `SVG_REF_ATTRIBUTES` or `SVG_IMAGE_ATTRIBUTES`, every value
  it writes (`to`, `from`, `by`, and each of `values`, split at every `;` as Chromium splits it) is
  made what that attribute itself is made. For an `href` that depends on the element animated
  (the one the animation's `href="#id"` names, else its parent): an `<image>` or `<feImage>`'s
  image becomes a `data:` URI, a `<use>`'s element is copied in and the value is the copy's `#id`,
  an `<a>`'s link is made absolute, and any other element's (or no element's) is set aside with a
  warning. A `url()` value is inlined or copied in as the attribute's is. In a `values` list a
  `data:` URI is percent-encoded with no `;` (`toListDataUri`). One that cannot be had becomes a
  value that fails without the network (`UNFETCHED_HREF`, `data:,`; `UNFETCHED_URL`; the failed
  reference's fallback), its URL in `data-page-archiver-unfetched-<to|from|by|values>`. A copied
  sprite's own `href` animation has its `#id`s renamed with the copy's.
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
with a cycle guard; every `url()`, and every string argument of an `image-set()` (`imageSetStrings`;
never a `type()` string), resolves against the sheet's own URL, never the page's
(`resolveCssUrl`). A stylesheet written as a `data:text/css` URL, linked or imported, is decoded
(`dataCssText`, base64 or percent-encoded) and made self-contained the same way; a relative URL in
it names nothing, live or in the archive, and becomes `url("data:,")`. A `data:` sheet of any
other type is left as it is in a standards-mode page, where a browser does not apply it; a
quirks-mode page (`CssContext.quirks`, from the archive's own doctype) applies a `data:` sheet of
any type, so there every one is inlined. An `@import` or `url()` that cannot be
had is set aside (above). CSS that does not parse keeps its text with `url()`s inlined, every
`@import` in it set aside as a comment (`setImportsAside`, which reads past comments and
strings), and a warning. An at-rule's name is read as Chromium reads it, its CSS escapes decoded
(`identAt`): `@\69mport`, which postcss cannot parse, is set aside, and `@i\6dport`, which postcss
reads as an at-rule `i`, is renamed `import` (`unescapeImportName`) and inlined as any `@import`.
A function's name is read the same way, whole (`myurl(` is not a `url(`) and decoded (`\75rl(` is),
wherever a `url()` is looked for: a declaration, an `@import`, a font's `src` list, CSS that does
not parse.

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
strips `on*` attributes, `REMOVED_ATTRIBUTES` (`ping`, and `attributionsrc`, an attribution
request a file opened from disk would send), any `URL_ATTRIBUTES` value that is a
script URL (`isScriptUrl`), a `data:` document in a frame, embed or object
(`DOCUMENT_URL_ATTRIBUTES`), and SVG animations that would write a script URL; `srcdoc` is
sanitized recursively. An animation that writes any other URL is kept, and its values are
inlined or set aside with the rest of the document (`inlineAnimation`, above). `sanitizeHtml` is the same over a string.

## The archive file

- `<meta name="page-archiver:*">` stamps (`STAMP_PREFIX`, `stamp`): source URL, canonical URL
  (`canonicalUrl`), capture time, tool version (`TOOL_VERSION`), the summarized warnings, and a
  sha256 of the file with the hash's own value zeroed (`finalizeStamp`); `verifyStamp` checks
  it, `readStamp` reads the metas back.
- Served and tested under `ARCHIVE_CSP` (`packages/core/src/archive.ts`):
  `default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; frame-src about:; form-action 'none'; base-uri 'none'; sandbox allow-scripts`.
  Anything left pointing at the network is refused by the browser and seen as a violation.
  Frames come from `about:` only (a captured frame is a `srcdoc`; the sanitizer strips a
  `data:` document from a frame). `sandbox` gives an archive opened as a page of its own
  (`/archive/<id>/original`) an opaque origin, never the server's, and no forms or popups;
  `form-action 'none'` and `base-uri 'none'` refuse a form target and a `<base>` that slipped
  past the sanitizer. It allows scripts only because a sandbox without `allow-scripts` makes
  Chromium draw native controls on every `<video>`; no script runs, since there is no
  `script-src` and `default-src` is `'none'`.

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
`createApp` (`api.ts`) refuses (403) any request whose `Host` is not exactly the address and
port the server bound (`127.0.0.1:<port>`, from the listener's `AddressInfo`), so a page at a
public name that resolves to 127.0.0.1 (`127.0.0.1.nip.io`, DNS rebinding) cannot read the API or
the token page; `localhost:<port>` is refused too. Some spellings never reach it: `@hono/node-server`
answers `127.1:<port>` at a port below 1000 or above 59999 with 400 ("Invalid host header"). Every write needs `Authorization: Bearer <token>`. The reader UI is
served under `UI_CSP`. Archives are served by `archiveResponse` (`serve-archive.ts`) with
`ARCHIVE_HEADERS` (`ARCHIVE_CSP`, `nosniff`, `no-referrer`, `no-store`) at
`/archive/<id>/original|reader` (`VIEWS`), and the UI shows them only in an
`<iframe sandbox="">` (`App`, `ui/src/App.tsx`).

## The extension (`packages/extension/src/`)

`saveTab` (`save.ts`): `snapshotTab` injects `CONTENT_FILES` (the serializer IIFE and
`content.ts`) into every frame; `createContentApi` (`content.ts`) marks child frames
(`FRAME_ATTRIBUTE`) and snapshots each frame; `buildTree` (`tree.ts`) rebuilds the frame tree;
`fetchResource` fetches each resource from the service worker (host permission for every site,
so no CORS), with the reader's cookies only for the page's own site (`credentialsFor`,
`hosts.ts`: the same registrable domain, from the public suffix list in `tldts`); a fetch with
cookies does not follow a redirect (`redirect: "manual"`), and a resource that redirects is
fetched again without them, since the cookies would go with every hop. A page could
otherwise name a resource on the reader's machine or network and have it inlined: `refusal`
refuses, before the fetch and again after a redirect, a loopback, private-network, link-local
or unspecified address (`hostClass`: 127/8, `localhost`, ::1, 10/8, 172.16/12, 192.168/16,
fc00::/7, 169.254/16, fe80::/10, 0/8, ::, and IPv4-mapped forms) unless it is the page's own
host, any port (a page served locally keeps its assets on another port), and the library
server (`serverUrl`) by any loopback name unless the page is the server's own; the resolver
sets a refused resource aside with a warning ending `; set aside`. core's `assemble` builds the archive, with
`node:crypto` replaced by a plain SHA-256 (`shims/node-crypto.ts`, `sha256.ts`). `deliver`
(`server.ts`) posts it to `pa serve` at the address in the popup (`DEFAULT_SERVER`), pairing by
reading the token from the UI page (`tokenFromPage`) and waiting at most `ANSWER_TIMEOUT_MS`
(120 s); when the server is not there, the archive is downloaded instead (`downloadName`).
The extension makes no poster frames: a video saved from Chrome keeps its own poster, or none.

## Limits, as built

- Closed shadow roots, `<frame>`s in a frameset, frames deeper than five, tainted canvases and
  video or audio files are not archived; each one is a warning. A frame deeper than five is left
  empty, its `srcdoc`, if it had one, kept in `data-page-archiver-unfetched-srcdoc`.
- A resource the site will not give again (an HTTP error, a cap) is not in the archive: it is
  set aside, so an archive opened online does not show it either. The warning and the set-aside
  attribute or comment name the URL.
- The extension refuses private hosts by the URL, not the address: a public host name that
  resolves to a private address (`127.0.0.1.nip.io`, DNS rebinding) is fetched, since the
  service worker never sees the address. `pa serve` refuses such a request by its `Host`, so the
  token page is not among them. A
  resource on another site that needs the reader's cookies is fetched without them, so it may be
  refused and set aside.
- The reader copy needs Readability to find an article; a page without one gets none.
