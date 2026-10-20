# page-archiver

Give it a URL (from the terminal, or one click in Chrome on the page you are
reading) and it saves the page as one self-contained `.html` file that
opens correctly offline, years from now, in any browser: styles, images and
fonts inside the file, no scripts, no network requests. Each save also gets a
clean reader-view copy and goes into a local, full-text-searchable library you
browse in a small local web app. Your archive is a folder on your disk; no
Pocket, no Instapaper, no subscription.

Status: the capture core works from the terminal (`pa save <url> -o <file>`), including
CSS-in-JS and adopted stylesheets, shadow DOM, canvas, form state, iframes and cookie walls,
and `pa save <url> -d <dir>` adds a reader copy, an MHTML copy, a full-page PNG and PDF, and
`meta.json`. `pa save <url>` saves into the library (a folder with a full-text index), which
`pa list`, `pa search`, `pa tag`, `pa open`, `pa reindex` and `pa import` work on. The local
UI and the extension are not built yet.

## Saving a page

```
npm run build
node packages/cli/dist/index.js save https://example.com/article -o article.html
```

Or into a folder, with everything a capture makes:

```
node packages/cli/dist/index.js save https://example.com/article -d article/ --tag reading
```

| File | What it is |
|---|---|
| `archive.html` | the self-contained page (below) |
| `reader.html` | the article alone, as [Readability](https://github.com/mozilla/readability) finds it in the archive (images already inlined), in a plain script-free page; light and dark follow the system |
| `archive.mhtml` | Chromium's own MHTML snapshot of the live page; Chromium opens it directly |
| `shot.png` | a full-page screenshot at 1280 wide |
| `shot.pdf` | the page printed to PDF (headless only; `--headed` skips it with a warning) |
| `meta.json` | id, url, canonicalUrl, title, byline, site, excerpt, lang, capturedAt, bytes per file, the archive's sha256, tags, tool and warnings; its JSON Schema is `META_SCHEMA` in `packages/core/src/meta.ts` |

`--no-reader`, `--no-mhtml`, `--no-shot` (PNG and PDF) and `--no-pdf` leave an extra out.
An extra that fails is a warning in `meta.json`, never a failed save; `meta.json` is written
last.

Options: `--profile <dir>` (a persistent Chromium profile, for pages behind a login),
`--wait-for <selector>` (a client-rendered page's content), `--dismiss <selector>`
(repeatable: cookie or consent buttons to click first), `--no-default-dismiss` (do not
click the built-in list of common consent-manager reject/accept buttons), `--headed`.

What a capture does: loads the page in Chromium (1280x900), records every response body,
waits for the network to go quiet, scrolls to the bottom so lazy images load, then
serializes the live DOM (images as the browser chose them from `srcset`/`<picture>`),
inlines every stylesheet (`@import` chains and `url()`s resolved against each sheet's own
URL) and image as `data:` URIs, removes every script, event handler, `javascript:` URL,
`<base>`, CSP `<meta>`, preload/prefetch hint and `<noscript>`, makes links absolute, and
stamps the file with `page-archiver:*` metas (source URL, capture time, tool version, and
a sha256 of the file). A resource that cannot be had is kept as an absolute link and
reported as a warning.

What the serializer freezes from the live page, not the HTML source:

- **Styles**: a `<style>` whose rules script changed (`insertRule`, CSS-in-JS libraries that
  write only to the CSSOM) is written from its CSSOM; sheets adopted by the document or a
  shadow root (`adoptedStyleSheets`) become `<style>` elements at the end of that root; a
  disabled sheet stays off.
- **Shadow DOM**: open shadow roots become declarative shadow DOM
  (`<template shadowrootmode="open">`), frozen like the rest. Closed roots cannot be read.
- **Canvas**: each canvas becomes an `<img>` of its bitmap. A canvas tainted by a
  cross-origin image cannot be read; it stays empty and is reported.
- **State**: typed values, checked boxes, selected options, open `<details>` (never a
  password or file input's value), and the scroll position of scrolled boxes, restored
  without script through `scroll-initial-target` where the browser supports it.
- **Frames**: every frame is captured recursively (same and cross origin) and written into
  its `<iframe>` as `srcdoc`, up to 5 levels deep; deeper frames are left empty and reported.
- **Fonts**: only `@font-face` rules the page actually loaded are kept, each with the one
  source file the browser fetched.

Warnings (resources over a size cap, resources that failed, tainted canvases, frames left
empty, an archive over 50 MB) are summarized in the archive's `page-archiver:warnings` meta.

## The library

`pa save <url>` with neither `-o` nor `-d` saves into the library: `~/Archive/pages`, or
`$PA_LIBRARY`, or `--library <dir>` on any library command.

```
~/Archive/pages/
  library.db                                   the search index (rebuilt from the folders)
  2026/10/tides-of-the-inner-basin-0a1b2c3d4e5f/
    archive.html  reader.html  archive.mhtml  shot.png  shot.pdf  meta.json
```

Each capture is a folder `YYYY/MM/<slug>-<id>/` (the UTC month it was taken). The folders
are the record: `library.db` (SQLite, an FTS5 index over title, byline, site and the reader
copy's text, or the page's visible text when it has no reader copy) holds nothing they do
not, so deleting it loses nothing: `pa reindex` (or the next command) builds it again.

Saving a URL the library already holds adds a new version beside the old one; captures of
one URL (its fragment ignored) are numbered 1, 2, … in capture order, and each new capture's
`meta.json` names the one before it in `versionOf`. `list` and `search` show each page's
newest version; `--all` shows every version.

```
pa list [--all] [--site <site>] [--tag <tag>]... [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit <n>] [--json]
pa search <words>... [--raw] [the same filters]
pa tag <id> [<tag>...] [--remove <tag>]...
pa open <id> [--reader] [--print]
pa reindex
pa import <file.html>... [--url <url>] [--tag <tag>]...
```

- `search`: every word must match; `word*` matches a prefix, `"two words"` a phrase, and
  `OR` between words either one. `--raw` passes SQLite FTS5 query syntax through. Each hit
  shows a snippet with the matched words in `[brackets]`; the title weighs most, then
  byline and site, then the text. Exit status 1 when nothing matches.
- `--site` matches the site's name or the URL's host, either without regard to case.
- An `<id>` can be any unique prefix of 4 characters or more.
- `tag` writes the tags into the page's `meta.json` first, so they survive a reindex.
- `open` opens the archive (or `--reader`, the reader copy) in the default browser;
  `--print` prints its path instead.
- `import` brings in pages saved by SingleFile: the URL and date from SingleFile's header
  comment (`--url` when the file has none), scripts and handlers removed, the file stamped,
  and a reader copy made. Importing the same file twice is refused.

## Layout

```
packages/
  serializer/   runs inside a page; bundled to one IIFE (esbuild)
  core/         drives Chromium, assembles the archive
  library/      the archive folder and its search index
  cli/          the `pa` command
  server/       local HTTP API and reader UI (127.0.0.1)
  extension/    Chrome MV3 extension
fixtures/       test pages (one port) and their assets (a second port, cross origin)
test/e2e/       Playwright: capture a fixture, open it offline, compare
```

## Commands

Node 22.18 or newer.

```
npm ci
npx playwright install chromium   # once
npm run lint
npm test                          # unit tests (vitest)
npm run build                     # tsc for every package, the serializer IIFE, then a type check of tests and fixtures
npm run test:e2e                  # build, then Playwright (starts the fixture server itself)
npm run fixtures                  # fixture server by hand: pages on :47310, assets on :47311
```

Set `PAGES_PORT` / `ASSETS_PORT` to move the fixture server.

## The offline test

`test/e2e/offline.spec.ts` captures each fixture page in `fixtures/pages/` (one per hard
case: CSS-in-JS, adopted sheets, `srcset`, lazy images, web fonts, `@import`, shadow DOM,
canvas, same- and cross-origin iframes, a sticky cookie wall, a client-rendered SPA, form
state), then opens the archive in a fresh
browser context that is offline, with a route that aborts every request except the
document, served under a CSP that allows only inline styles and `data:` URIs. It asserts
zero blocked requests, zero CSP violations, and a full-page screenshot within 1% of the
live page. `test/e2e/extras.spec.ts` saves two articles with `-d`, validates `meta.json`
against its schema, opens the reader copy under the same offline CSP, parses the MHTML
file's MIME parts and opens it in Chromium offline. `test/e2e/offline-harness.spec.ts` proves the harness sees a request, a
violation and a script when an archive has one. `test/e2e/library.spec.ts` builds a library of
20 fixture pages in the test's output folder (every page in `fixtures/pages/` saved with
`pa save`, plus the SingleFile-style saves in `fixtures/import/` brought in with `pa
import`), searches it for words that appear in one article only, deletes `library.db`,
reindexes and checks the same searches return the same results, and saves a page twice to
check version 1 is kept beside version 2.

## The SingleFile oracle

`npm run oracle` captures every fixture with page-archiver and with
[SingleFile](https://github.com/gildas-lormeau/single-file-cli) (`single-file-cli`, pinned,
run through `npx` as a separate program and never linked or bundled), puts both through the
same offline assertion, and writes a pass/size table to `test-results/oracle.md`. It is a
comparison, not a gate: the run fails only when page-archiver fails.
