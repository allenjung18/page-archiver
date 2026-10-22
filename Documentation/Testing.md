# Testing

Four layers, from fast and offline to slow and live. Only the first two run by default; the
oracle and the smoke run are opt-in, because one runs a third-party program and the other loads
real pages from the network. Each statement names the file or symbol it rests on.

| Command | What | Network |
|---|---|---|
| `npm test` | unit tests (vitest) | none |
| `npm run test:e2e` | the end-to-end specs (Playwright, `test/e2e/`) over the local fixture server | loopback only |
| `npm run oracle` | every fixture captured by page-archiver and by SingleFile, compared (`test/oracle/`) | loopback, plus `npx` fetching the pinned SingleFile once |
| `npm run smoke` | the real-site smoke list (`test/smoke/`) | the pages in `test/smoke-urls.txt` |

`npm run test:e2e`, `oracle` and `smoke` build first (`package.json` scripts): the e2e specs run
the built `pa`, the built serializer bundle and the built extension. They need Chromium:
`npx playwright install chromium`.

## Unit tests (`npm test`)

`vitest.config.ts`: every `*.test.ts` beside its code in `packages/*/src/`, in `fixtures/` and
in `test/`. The workspace packages resolve to their sources (`resolve.alias`), so no build is
needed first. DOM tests run in happy-dom with stylesheet, script and frame loading switched off
(`environmentOptions.happyDOM.settings`), so a unit test cannot reach the network.

Tests that pin a case a reader could get wrong: a password or file input typed `PASSWORD`
(`hardening.test.ts`); two page ids sharing a prefix, which `get` and `remove` refuse
(`library.test.ts`); the reader UI's CSP written out byte for byte and `startServer` on a port in
use (`api.test.ts`); the extension's `ANSWER_TIMEOUT_MS` abort and `credentials: "omit"`
(`server.test.ts`); a malformed UTF-8 sequence (`bytes.test.ts`); the singular warning in the popup
(`popup.test.ts`); the 12-character page id's rejection of the biased bytes (`meta.test.ts`, the
random source fed by hand); a finish event the network tracker never saw start (`settle.test.ts`);
the id a child frame's element is given, and that it is given before the parent is read
(`frames.test.ts`); the icon, TrueType, OpenType and AVIF signatures (`datauri.test.ts`).

## The fixture server (`fixtures/server.ts`)

Two origins on `HOST` (`127.0.0.1`): the pages on `DEFAULT_PAGES_PORT` (47310) and the assets
on `DEFAULT_ASSETS_PORT` (47311), so every fixture loads cross-origin resources the way real
pages do. `PAGES_PORT` / `ASSETS_PORT` override both (`test/e2e/env.ts`) when another checkout
holds the defaults. `playwright.config.ts` starts it as the `webServer` and never reuses a
running one (`reuseExistingServer: false`), so a server from another checkout cannot serve its
fixtures here. `npm run fixtures` starts it by hand.

One page per hard case of a capture, in `fixtures/pages/`: adopted sheets, an `attributionsrc`
attribution request (`attribution-src`), canvas, a cookie wall, CSS-in-JS, stylesheets written as `data:` URLs and one that does not parse
(`data-sheets`), form state, nested same- and cross-origin iframes, `srcdoc` frames nested past
the depth cap (`deep-frames`), an `@import` chain, an `@import` written with CSS escapes
(`escaped-import`), `url()` and `image-set()` names written with CSS escapes (`escaped-url`), `url()`s
and `image-set()` strings in the shapes only the CSS tokenizer reads (left open at the end of a
`<style>` or a `style` attribute, a backslash-newline in a string, a comment before the `)`, a
no-break or ideographic space in an unquoted one; `css-tokenizer-edges`), a custom property's
string that `var()` brings into an `image-set()` (a `style` attribute, a `<style>`, `:root`, a
relative one in a linked sheet, one that answers 404 live and is set aside, and the strings that
must be kept as written: a `content` value, a font name, the page's own file name, an image used
only on `:hover`; `var-image-set`), a string a substitution brings into an `image-set()` (a `var()`
fallback in a `<style>` and a `style` attribute, nested too, an `if()` branch, an `@function`'s
result and argument (in an `image-set()` and in a call whose result holds one), an `@property`'s `initial-value` behind an escaped at-rule or descriptor name
or in a sheet postcss cannot parse, an SVG `mask`'s `image-set()` image, in the attribute and
in a `<set>`, and a PNG its server declares as `text/html` or `application/json`, which the fixture
server's `?type=` query sets; `substitution-image-set`), lazy images,
external references (`<object>`, `<embed>` and SVG `<use>` of a sprite file, in
`fixtures/pages/sprites/`), SVG effects and paints from another file, an SVG `cursor` image and
`image-set()` strings (`svg-effects`), SVG `<set>` and `<animate>` elements that write a URL
attribute (`smil-urls`), link hints (fetch hints and touch icons), video and audio, a news article, a plain article,
shadow DOM, a single-page app, `srcset`, resources the site answers with an error
(`unfetched`), a hidden lazy image at another loopback name than the page's own host, which the
capture must refuse to fetch (`private-host`, written with the fixture server's
`{{ASSETS_LOCALHOST}}`), web fonts. `fixtures/import/` holds SingleFile saves for
`pa import`. The binary assets are generated (`fixtures/make-images.ts`), or made as their
`README.md` says (`fixtures/assets/media/README.md`).

## End-to-end specs (`npm run test:e2e`)

All in Chromium at `VIEWPORT` (1280x900, scale 1), `retries: 0` (`playwright.config.ts`).

- **`offline.spec.ts`, the central test.** For each entry of `FIXTURES` (and a test that every
  page in `fixtures/pages/` has one): screenshot the live page (`screenshotLive`, `live.ts`),
  capture it with core's `capture`, and assert: the capture's warnings are exactly the expected
  ones; nothing was fetched after the fact (`stats.fetched`, unless the entry says otherwise);
  no `<script>` and no `on*=` attribute survive; `verifyStamp` holds; the warnings in
  `meta.json` and in the stamp agree; the entry's own `check`. Then the archive is opened offline
  and must make **zero requests**, raise **zero CSP violations**, and differ from the live
  screenshot by at most `MAX_DIFF` (1%) of pixels (`diffScreenshots`, `compare.ts`, pixelmatch).
  An entry with `withoutCsp` is opened a second time with no CSP, as a file opened from disk is,
  and must still make zero requests. `LIVE_BROKEN` (`live.ts`) names the images a fixture is
  built not to load; any other broken image on the live page fails it.
- **`openOffline` (`offline.ts`), the offline assertion** shared by every layer: the archive is
  served at `ARCHIVE_URL` (a `.localhost` host, so a secure context, as a file opened from disk
  is) in an offline context, a route aborts every
  request but the document, the document carries `ARCHIVE_CSP`, and every
  `securitypolicyviolation` event is collected. Before its full-page screenshot it waits for
  fonts and decodes every image, so an image the archive has is never photographed blank.
- **`offline-harness.spec.ts`** proves that harness can see what the offline spec asserts is
  absent: a network request, a CSP violation, a script, and a request Chromium makes only from a
  secure context.
- **`cli.spec.ts`**: `pa save <url> -o <file>` writes the archive; the exit codes (2 for an unknown
  command, an unknown id or a usage error, 1 for a search with no hit, a missing import file, an
  unloadable page or `pa serve` on a port in use, 0 for `pa help`); `pa serve` and `pa open` with no
  browser opener installed.
- **`extras.spec.ts`**: `pa save -d <dir>` writes the archive, the reader copy, MHTML, PNG, PDF
  and a `meta.json` valid against `META_SCHEMA`; the reader and MHTML copies open offline; the PNG
  is as tall as the live page, and `printPdf` keeps a page's backgrounds (read from the PDF's
  drawing operators).
- **`library.spec.ts`**: every capture fixture saved with `pa save` and the SingleFile saves
  brought in with `pa import`, then search, a rebuilt index, versions, tags and `pa open`. Every
  command names its library and `PA_LIBRARY` points there too, so no test reaches
  `~/Archive/pages`. A test of four `pa save` of one URL at once is skipped (`test.fixme`) until
  the index tolerates it; see Review.md, "Docs and tests".
- **`reader-ui.spec.ts`**: `pa serve` over a test library (search, filters, Original/Reader,
  tags, delete, re-capture, and re-capture of a page that now answers 500 or cannot be reached,
  against a loopback page the test controls), the archive route's CSP header byte for byte, and a planted script
  that must not run. Always `--no-open` with `PA_NO_OPEN=1`.
- **`extension.spec.ts`**: the built extension in a throwaway profile (`extension.ts`): the
  popup saves a fixture into a test library through `pa serve`, and with no server the download
  fallback's `archive.html` passes the offline assertion; a page whose text only the tab holds
  (`sessionStorage`) is saved with that text, so the extension's own capture, not the server's
  fetch, is what is archived.

Run one spec: `npx playwright test test/e2e/offline.spec.ts -g media` after `npm run build`.

## The oracle (`npm run oracle`)

`test/oracle/oracle.spec.ts` captures every fixture with page-archiver and with SingleFile
(`SINGLEFILE`, a pinned `single-file-cli`, run through `npx` as a separate program and never
imported), puts both through `openOffline`, and compares sizes and pixel diffs. SingleFile's
result is recorded, never asserted. `setup.ts` clears the rows; `table.ts` writes
`test-results/oracle.md` (`playwright.oracle.config.ts`).

## The real-site smoke run (`npm run smoke`)

`test/smoke-urls.txt` lists real pages, one per line:

```
label | url | text the archive must contain | miss: <reason>
```

`parseSmokeList` (`test/smoke/list.ts`) rejects a malformed line, a label outside `[\w.-]`, a
repeated label and a URL that is not http(s). For each page, `test/smoke/smoke.spec.ts` captures
it once (with the reader copy and a PNG, `capture` with `extras`), opens the archive with
`openOffline`, and fails on:

- any request the archive made;
- any CSP violation, exactly as in the offline assertion. A resource the site would not give (an
  HTTP error, a cap) is set aside by the capture, with a warning ending `; set aside`, so it is
  never a violation;
- the archive failing to open at all;
- the expected text missing from `document.title` plus the body's text, compared ignoring case
  and runs of white space (`normalizeText`): this tells a saved page from a bot wall or an error
  page.

The live-versus-offline pixel diff is reported, never asserted: real pages move. A line with
`miss: <reason>` marks a page known not to save cleanly; its test is expected to fail
(`test.fail`), so Playwright reports it when it starts passing. A site that refuses headless
capture is recorded that way, never worked around.

After the run, `test/smoke/table.ts` writes `test-results/smoke.md`: one row per page (result,
size, diff, warnings, problems) and each page's warnings. Each test writes a
provisional failing row before it starts, so a page whose test throws or runs out of time is
still in the table. Captures stay in
`test-results/smoke/<test>/capture/` until the next run. `playwright.smoke.config.ts` reuses the
main config without the fixture server, two workers.

The list in the repository is ten public pages chosen to cover the common shapes (a news
article, a docs page, a GitHub README, a blog with web fonts and video, a recipe page with lazy
images and many ads, Wikipedia, MDN, Medium, Substack, a product page). Replace them with the
pages you care about.

## Adding a fix

A bug found on a real page gets a fixture in `fixtures/pages/` that reproduces it offline, and an
entry in `FIXTURES` (`offline.spec.ts`) that fails without the fix. The smoke run finds bugs; the
fixture keeps them fixed. [Review.md](Review.md) lists the fixes this rule produced.
