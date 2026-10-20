# page-archiver

Give it a URL (from the terminal, or one click in Chrome on the page you are
reading) and it saves the page as one self-contained `.html` file that
opens correctly offline, years from now, in any browser: styles, images and
fonts inside the file, no scripts, no network requests. Each save also gets a
clean reader-view copy and goes into a local, full-text-searchable library you
browse in a small local web app. Your archive is a folder on your disk; no
Pocket, no Instapaper, no subscription.

Status: scaffold only. The offline test is written and fails, because there is no
capture yet.

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

`test/e2e/offline.spec.ts` captures each fixture, then opens the archive in a fresh
browser context that is offline, with a route that aborts every request except the
document, served under a CSP that allows only inline styles and `data:` URIs. It asserts
zero blocked requests, zero CSP violations, and a full-page screenshot within 1% of the
live page. `test/e2e/offline-harness.spec.ts` proves the harness sees a request, a
violation and a script when an archive has one.
