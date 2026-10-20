# Review: real sites, 2026-10-20

A review pass over what the fixtures could not show: ten real pages (`test/smoke-urls.txt`)
captured with `npm run smoke` and opened offline, every failure traced to its cause, and the
documentation checked against the code. Each finding is **must-fix** (an archive that breaks
the offline promise, or a test that reports something false), **should-fix**, or **consider**.

Every must-fix item is fixed, and each fix has a test that fails without it (a fixture in
`fixtures/pages/` with its `FIXTURES` entry in `test/e2e/offline.spec.ts`, or a harness test).
**Open must-fix items: none.**

## Smoke results

First run: 5 of 10 pages passed. After fixes 1 to 4: 10 of 10, nine of them at or under 1.25%
live-versus-offline pixel difference and the product page at 7.63%, which was finding 5: the
same capture re-opened with the fixed harness differs by 0.00%. (The difference is read, not
asserted: real pages move.)

## Must-fix (all fixed)

| # | Seen on | What went wrong | Fix | Test that fails without it |
|---|---|---|---|---|
| 1 | news, recipe | `<link rel="compression-dictionary">`, which an ad script adds, survived into the archive; Chromium fetches it as soon as the page loads, so the archive made a request (a `connect-src` violation) | `compression-dictionary` and `dictionary` added to `REMOVED_LINK_RELS` (`sanitize.ts`) | `link-hints` fixture; `sanitize.test.ts` |
| 2 | fonts-blog, recipe | `<video src>` (an MP4, and a `blob:` stream) kept its URL: every video was a `media-src` violation, and its box showed nothing offline | `freezeMedia` (`inline/html.ts`) moves every `<video>`, `<audio>`, `<source>` and `<track>` URL to `data-page-archiver-src`; `capturePosterFrames` (`posters.ts`) screenshots the frame each video was showing and it becomes the poster; one warning per element, summarized as "N video or audio files not archived" (`warnings.ts`) | `media` fixture (`fixtures/assets/media/still.webm`); `html.test.ts`; `warnings.test.ts` |
| 3 | fonts-blog | the poster frame, a whole-pixel screenshot, made the video box 2px shorter than the live one, which moved everything below it (a 100% pixel difference) | the video's own `videoWidth / videoHeight` is kept as `VIDEO_RATIO_ATTRIBUTE` and becomes `aspect-ratio` in its `style`, applied before `style` URLs are inlined | `media` fixture (`aspect-ratio: 320 / 180`); `html.test.ts` |
| 4 | recipe | `<link rel="apple-touch-icon-precomposed">` kept its URL (an `img-src` violation): only `icon` and `apple-touch-icon` were inlined | `ICON_RELS` (`inline/html.ts`) | `link-hints` fixture |
| 5 | product | the offline harness photographed large `decoding="async"` images before Chromium painted them, so they were blank in the screenshot (7.63% difference) although the archive had every one of them | `openOffline` (`test/e2e/offline.ts`) decodes every image, capped at 5 s, before its screenshot; the product page then differs by 0.00% | `offline-harness.spec.ts`, "large decoding=async images below the fold are in the screenshot" |

The fixes were each shown to matter: with the change undone, its test fails on its own
assertion, and passes again with the change restored.

## Not a page-archiver bug

| # | Seen on | What | Done |
|---|---|---|---|
| 6 | mdn | the expected text was wrong: the page's heading is "HTML image embed element" | the list corrected |
| 7 | substack | an avatar the site answers with HTTP 404 is kept as a link, so the archive asks for it and the CSP refuses it | behaviour as designed and reported in the capture's warnings; the smoke run counts such a violation under "kept as links" instead of failing the page (`splitViolations`, `test/smoke/list.ts`) |
| 8 | README, `library.spec.ts` | both said the library test uses 20 fixture pages; the count follows `fixtures/pages/` | both now say every fixture page; the spec asserts at least 20 |

## Should-fix

None.

## Consider

| # | Seen on | What | Why it is not fixed |
|---|---|---|---|
| 9 | recipe | 17 warnings for ad cookie-sync frames nested deeper than `MAX_FRAME_DEPTH`; they are invisible | the warnings are true; hiding them would need a rule for which frames are "invisible", and a page that hides real content in a frame would then lose it silently |
| 10 | medium, recipe | "network not idle after 15 s": ad and analytics traffic never stops | the capture goes ahead after `IDLE_CAP_MS`, as designed, and the archives are complete |
| 11 | substack | "scrolled 60 screens and stopped": the comments keep loading as the page is scrolled | `MAX_SCROLL_STEPS` is the guard against endless pages; the article itself is all there |
| 12 | (extension) | a page saved from Chrome gets no poster frames: Playwright's element screenshot is not available to an extension | the video keeps the page's own poster; capturing a frame from the extension would need `chrome.tabs.captureVisibleTab` and scrolling the reader's tab |
| 13 | smoke list | the committed pages were chosen for coverage, not by the person who uses the archive | replace them with your own pages and run `npm run smoke` |
