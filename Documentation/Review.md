# Review: real sites, 2026-10-20

A review pass over what the fixtures could not show: ten real pages (`test/smoke-urls.txt`)
captured with `npm run smoke` and opened offline, every failure traced to its cause, the
documentation checked against the code, and a second reader's review of the resulting change. Each finding is **must-fix** (an archive that breaks
the offline promise, or a test that reports something false), **should-fix**, or **consider**.

Every must-fix item is fixed, and each fix has a test that fails without it (a fixture in
`fixtures/pages/` with its `FIXTURES` entry in `test/e2e/offline.spec.ts`, or a harness test).
**Open must-fix items: none.**

## Smoke results

First run: 5 of 10 pages passed. After fixes 1 to 4: 10 of 10 with violations for resources kept
as links excused, nine of them at or under 1.25% live-versus-offline pixel difference and the
product page at 7.63%, which was finding 5: the same capture re-opened with the fixed harness
differs by 0.00%. (The difference is read, not asserted: real pages move.)

That excuse was then dropped (finding 17): the smoke run applies the offline assertion as it is,
so the two pages whose only violations are resources the site refused are recorded misses.
Final run, with every fix: 8 pages pass and the two recorded misses fail as recorded
(Playwright: 10 passed, a recorded miss that fails counts as passing). The eight are at or under
1.25% difference, the product page at 0.00%. On that run, the recipe site's fourth capture of
the day, the site also answered 48 of its own and its partners' fonts and icons with HTTP 403,
so its archive lacks them (a 100% difference: the page height changed); its miss reason says
so. That is the site refusing a headless browser, recorded, not worked around.

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
| 7 | substack, recipe | resources the site answers with an HTTP error (an avatar; ad-sync pixels) are kept as links, as designed and reported in the capture's warnings, so the archive refers to the network and the CSP refuses it | both pages recorded as misses with that reason; the report counts these violations apart (`splitViolations`, `test/smoke/list.ts`). See consider 18 |
| 8 | README, `library.spec.ts` | both said the library test uses 20 fixture pages; the count follows `fixtures/pages/` | both now say every fixture page; the spec asserts at least 20 |

## From the second review (all fixed)

| # | What went wrong | Fix | Test that fails without it |
|---|---|---|---|
| 14 | `capturePosterFrames` counted videos with `querySelectorAll`, which stops at shadow roots, but picked them with a locator that does not: a video inside a player component got no poster frame, and one before a light-DOM video pushed the last one out | count and wait through the same `frame.locator("video")` (`videosReady`) | `media` fixture: a `<video-card>` with its video in an open shadow root |
| 15 | the poster screenshot scrolled every box around the video into view (a carousel onto its video slide), and the snapshot froze that scroll position; only the window was reset, and only when a screenshot succeeded | every ancestor's and the window's scroll position is saved before each screenshot and put back after it, whatever happens | `media` fixture: the shadow-root video sits on the second slide of a scroll strip, which must stay on its first |
| 16 | a smoke test that threw while opening the archive, or ran out of time, wrote no row, so the report left out exactly the failing page | a provisional failing row is written first; opening the archive is caught and reported as a problem | none automatic (the smoke run needs the network); `Testing.md` describes it |
| 17 | the smoke run excused CSP violations for resources kept as links, so it was looser than the offline assertion it claims to run | every violation fails the page; kept-as-link ones are named apart | `list.test.ts` (`splitViolations`); recipe and substack are now recorded misses |

## Decided by the owner

| # | What | Decision | Fix | Test that fails without it |
|---|---|---|---|---|
| 18 | a resource the capture cannot have was kept as an absolute link: a refused request under the archive CSP, and a real fetch from the live site (on the recipe page, ad-sync pixels) when the file is opened from disk | set it aside (D-516 (a), 2026-10-20): an archive asks the network for nothing, at the cost that an archive opened online no longer shows what the capture missed | `inline/html.ts` moves the attribute to `data-page-archiver-unfetched-<name>` (`UNFETCHED_ATTRIBUTE_PREFIX`); `inline/css.ts` turns a `url()` into `url("data:,")` with a comment naming the URL and an `@import` into a comment; warnings end `; set aside`; the smoke run's "kept as links" count is gone | the `unfetched` fixture (six HTTP 404s, opened again with no CSP: zero requests); the set-aside tests in `inline/html.test.ts` and `inline/css.test.ts` |

After it, the smoke run passes all ten pages (Playwright: 10 passed, no recorded misses): recipe
and substack, the two misses, now save cleanly. Live-versus-offline difference at or under 1.25%,
except recipe at 3.75% (read, not asserted: real pages move).

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
