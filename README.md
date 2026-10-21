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
`pa list`, `pa search`, `pa tag`, `pa open`, `pa reindex` and `pa import` work on, and
`pa serve` opens in the browser to read it. The Chrome extension saves the tab you are
reading, signed in as you are, into the library through `pa serve`.

To try it on your own pages, see [Documentation/TryIt.md](Documentation/TryIt.md).

## Install

Node 22.18 or newer, then from this folder:

```
npm ci
npx playwright install chromium   # the browser pa captures with (once)
npm run build
npm link -w @page-archiver/cli    # puts `pa` on your PATH
```

Without the link, `node packages/cli/dist/index.js` is `pa`. `npm unlink -g @page-archiver/cli`
takes it off again.

## Saving a page

```
pa save https://example.com/article -o article.html
```

Or into a folder, with everything a capture makes:

```
pa save https://example.com/article -d article/ --tag reading
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
a sha256 of the file). A resource that cannot be had (the site answers an error, or it is over a
size cap) is set aside: its URL moves into a `data-page-archiver-unfetched-*` attribute or a CSS
comment, and a warning names it, so the archive never asks the network for anything, even
opened straight from disk.

Video and audio files are not archived: they are often hundreds of megabytes, streamed in
pieces, or both. Each `<video>` keeps a still of the frame it was showing as its poster (or the
page's own poster), at its own aspect ratio, and every media element keeps its source URL in
`data-page-archiver-src`, so the archive shows where the video was without trying to load it.
A save from the Chrome extension keeps the page's own poster only.

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

## Reading the library in the browser

```
pa serve [--port <n>] [--no-open]
```

starts a small server on `http://127.0.0.1:47320/` (only on this machine's loopback address,
never on the network) and opens it in the default browser (`--no-open`, or `PA_NO_OPEN=1`,
does not). It prints a write token at start. The page lists the library newest first; type to
search (hits highlighted in a snippet), narrow by site, tag and capture date, or show every
version. Choosing a page shows it with an **Original / Reader** toggle, its tags (add and
remove), **Re-capture** (saves the URL again as the page's next version) and **Delete**
(removes that capture's folder, after a confirmation). Ctrl-C stops the server.

Archived pages are untrusted HTML, so they are never put into the app's own page: each is
served by its own route, `/archive/<id>/original` or `/archive/<id>/reader`, under

```
Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; frame-src data: about:
```

and shown in an `<iframe sandbox="">` (no scripts, no forms, no popups, no same-origin
access). Either one alone keeps a script that slipped into an archive from running; the
tests check both.

The API (JSON) under `/api`: `GET pages`, `GET search?q=`, `GET facets`, `GET pages/<id>`
take the list filters as query parameters (`site`, `tag`, `since`, `until`, `all=1`,
`limit`). The writes, `POST save` (`{"url", "tags"}` captures the URL;
`{"url", "html", "tags"}` adds an archive made elsewhere, the extension's, sanitized again,
and answers 409 when those bytes are in the library already), `POST pages/<id>/recapture`,
`POST pages/<id>/tags` (`{"add", "remove"}`) and `DELETE pages/<id>`, need
`Authorization: Bearer <token>`; the reader UI is handed the token in its page. Requests
that name any host other than `127.0.0.1:<port>` or `localhost:<port>` are refused.

## Saving from Chrome

`npm run build` writes the extension to `packages/extension/dist/unpacked`. Load it once in
Chrome: `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, choose that
folder.

With `pa serve` running, click the extension's button on any http(s) page, add tags if you
like and press **Save**, or right-click the page and choose **Save page to archive**. The
extension serializes the page as your browser has it (signed in, past a paywall you pay for,
after you have scrolled or opened what you wanted) in every frame, fetches its styles, images
and fonts from the extension's service worker (with your cookies for the page's own site only,
and never from your machine or local network unless the page itself is there), builds the same
self-contained archive `pa save` does, and posts it to the server, which sanitizes it again and
adds it to the library. The popup then says **Saved** and **Open in library** opens the reader.
The first save pairs with the server by reading the write token from its page; the server
address is a setting in the popup (default `http://127.0.0.1:47320/`).

When the server is not running, the extension downloads the archive instead, as
`page-archiver/<site-title>-<time>.html` in the download folder; `pa import` adds it to the
library later. The extension never sends a page anywhere but the server address you set.

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
test/oracle/    the same fixtures through SingleFile, for comparison
test/smoke/     real pages from test/smoke-urls.txt, captured and opened offline
Documentation/  Architecture.md (how a capture works), Testing.md, Review.md, TryIt.md
```

## Commands

[![CI](https://github.com/allenjung18/page-archiver/actions/workflows/ci.yml/badge.svg)](https://github.com/allenjung18/page-archiver/actions/workflows/ci.yml)
CI runs lint, typecheck, unit tests and the offline e2e on every push and pull request.

```
npm ci
npx playwright install chromium   # once
npm run lint
npm run typecheck                 # tsc for the packages and for tests and fixtures
npm test                          # unit tests (vitest)
npm run build                     # tsc for every package, the serializer IIFE, the reader UI (Vite), then a type check of tests and fixtures
npm run test:e2e                  # build, then Playwright (starts the fixture server itself)
npm run fixtures                  # fixture server by hand: pages on :47310, assets on :47311
npm run oracle                    # every fixture through page-archiver and SingleFile, compared
npm run smoke                     # the real pages in test/smoke-urls.txt (uses the network)
```

Set `PAGES_PORT` / `ASSETS_PORT` to move the fixture server.

## The offline test

`test/e2e/offline.spec.ts` captures each fixture page in `fixtures/pages/` (one per hard
case: CSS-in-JS, adopted sheets, `srcset`, lazy images, web fonts, `@import`, shadow DOM,
canvas, same- and cross-origin iframes, a sticky cookie wall, a client-rendered SPA, form
state, video and audio, fetch hints and touch icons), then opens the archive in a fresh
browser context that is offline, with a route that aborts every request except the
document, served under a CSP that allows only inline styles and `data:` URIs. It asserts
zero blocked requests, zero CSP violations, and a full-page screenshot within 1% of the
live page. `test/e2e/extras.spec.ts` saves two articles with `-d`, validates `meta.json`
against its schema, opens the reader copy under the same offline CSP, parses the MHTML
file's MIME parts and opens it in Chromium offline. `test/e2e/offline-harness.spec.ts` proves the harness sees a request, a
violation and a script when an archive has one. `test/e2e/library.spec.ts` builds a library of
every fixture page in the test's output folder (every page in `fixtures/pages/` saved with
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

## The real-site smoke run

Fixtures prove the hard cases one at a time; real pages combine them with ads, consent
managers and a few hundred requests. `npm run smoke` captures every page listed in
`test/smoke-urls.txt` from the live web and opens each archive offline: it fails a page on any
request or CSP violation the archive makes, exactly as the offline test does, or when the page's
expected text is missing, which tells a saved article from a bot wall. A resource the site
refused (an HTTP error) is set aside, so it is not a request. `test-results/smoke.md` gets a
table of results, sizes,
live-versus-offline pixel differences and warnings. It is never part of `npm test` or
`npm run test:e2e`.

The committed list is ten public pages of different shapes, none of them a recorded miss (an
HTTP error on a page's own resource is set aside, so it no longer fails a page); replace it with
the pages you save. A page known not to save gets `| miss: <reason>` on its line instead of a workaround.
Every bug the smoke run found is reproduced by a fixture, listed in
[Documentation/Review.md](Documentation/Review.md); [Documentation/Testing.md](Documentation/Testing.md)
has the details.
