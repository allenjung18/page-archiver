# page-archiver

Give it a URL (from the terminal, or one click in Chrome on the page you are
reading) and it saves the page as one self-contained `.html` file that
opens correctly offline, years from now, in any browser: styles, images and
fonts inside the file, no scripts, no network requests. Each save also gets a
clean reader-view copy and goes into a local, full-text-searchable library you
browse in a small local web app. Your archive is a folder on your disk; no
Pocket, no Instapaper, no subscription.

Status: the capture core works from the terminal (`pa save <url> -o <file>`). The
library, reader view, local UI and extension are not built yet.

## Saving a page

```
npm run build
node packages/cli/dist/index.js save https://example.com/article -o article.html
```

Options: `--profile <dir>` (a persistent Chromium profile, for pages behind a login),
`--wait-for <selector>` (a client-rendered page's content), `--dismiss <selector>`
(repeatable: cookie or consent buttons to click first), `--headed`.

What a capture does: loads the page in Chromium (1280x900), records every response body,
waits for the network to go quiet, scrolls to the bottom so lazy images load, then
serializes the live DOM (images as the browser chose them from `srcset`/`<picture>`),
inlines every stylesheet (`@import` chains and `url()`s resolved against each sheet's own
URL) and image as `data:` URIs, removes every script, event handler, `javascript:` URL,
`<base>`, CSP `<meta>`, preload/prefetch hint and `<noscript>`, makes links absolute, and
stamps the file with `page-archiver:*` metas (source URL, capture time, tool version, and
a sha256 of the file). A resource that cannot be had is kept as an absolute link and
reported as a warning.

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

`test/e2e/offline.spec.ts` captures each fixture (plain article, lazy images, an `@import`
chain, a client-rendered SPA), then opens the archive in a fresh
browser context that is offline, with a route that aborts every request except the
document, served under a CSP that allows only inline styles and `data:` URIs. It asserts
zero blocked requests, zero CSP violations, and a full-page screenshot within 1% of the
live page. `test/e2e/offline-harness.spec.ts` proves the harness sees a request, a
violation and a script when an archive has one.
