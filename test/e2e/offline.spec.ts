// The project's central test: a captured page must open with the network gone and look like
// the live page did. One fixture per hard case of a capture (fixtures/pages/<name>.html).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { ARCHIVE_FILE, capture, readStamp, verifyStamp, type Archive } from "@page-archiver/core";
import { fixturePages } from "../../fixtures/server.ts";
import { diffScreenshots } from "./compare.ts";
import { fixtureUrl } from "./env.ts";
import { LIVE_DISMISS, screenshotLive } from "./live.ts";
import { openOffline } from "./offline.ts";

/** At most this fraction of pixels may differ between the live page and its archive. */
const MAX_DIFF = 0.01;

interface Fixture {
  /** Warnings the fixture is built to raise, in order; any other capture warning fails the test. */
  warnings?: RegExp[];
  /** What this fixture proves about the archive's HTML, beyond opening offline and looking right. */
  check?: (html: string, archive: Archive) => void;
}

/** Occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string | RegExp) => hay.split(needle).length - 1;

const FIXTURES: Record<string, Fixture> = {
  "plain-article": {},
  "lazy-images": {},
  "import-chain": {
    // shared/type.css imports chain/main.css back; browsers drop that import, and so does capture
    warnings: [/css\/shared\/type\.css: @import \S+\/css\/chain\/main\.css is a cycle; dropped$/],
  },
  spa: {},
  "css-in-js": {
    check(html) {
      // rules that exist only in the CSSOM made it into the file
      expect(html).toContain(".sc-d4e5f6 h1");
      expect(html).toContain(".css-1x2y3z img");
      // the stale text emotion's element still held is gone, and the disabled sheet stays off
      expect(html).not.toContain(".css-stale");
      expect(html).toMatch(/<style id="switched-off" media="not all">/);
    },
  },
  "adopted-sheets": {
    check(html) {
      expect(count(html, "data-page-archiver-adopted"), "document (2) and shadow roots (2) adopted sheets").toBe(4);
      expect(html).toMatch(/<style data-page-archiver-adopted="" media="print">/);
      expect(count(html, '<template shadowrootmode="open">')).toBe(2);
    },
  },
  srcset: {
    check(html) {
      // one image per <img>, each the candidate the browser chose; no srcset, no <source>
      expect(html).not.toMatch(/srcset=|<source|<picture/);
      expect(count(html, "data:image/png;base64,")).toBe(4);
    },
  },
  "web-fonts": {
    check(html, archive) {
      // only the latin face was loaded: the cyrillic, latin-ext and unused rules are gone, and of
      // the latin face's src list only the woff2 the browser fetched is inlined
      expect(count(html, /@font-face\s*\{/)).toBe(1);
      expect(count(html, "data:font/woff2;base64,")).toBe(1);
      expect(html).not.toContain("data:font/woff;base64,");
      expect(archive.stats.fontFacesDropped).toBe(3);
    },
  },
  "shadow-dom": {
    check(html) {
      // two product cards, a price tag inside each (nested roots), and the declarative one
      expect(count(html, '<template shadowrootmode="open">')).toBe(5);
      expect(html).toContain("$24.00");
    },
  },
  canvas: {
    warnings: [/^canvas #tainted is tainted by a cross-origin image and cannot be read; it is empty in the archive$/],
    check(html) {
      expect(count(html, "data-page-archiver-canvas")).toBe(2);
      expect(html).toMatch(/<img class="chart" id="bars" width="1280" height="640" src="data:image\/png;base64,/);
      expect(html).not.toContain("fallback text that is never shown");
      expect(count(html, "<canvas")).toBe(1);
    },
  },
  iframes: {
    check(html, archive) {
      // four frames in the page, one more inside the same-origin frame
      expect(archive.stats.frames).toBe(5);
      expect(html).not.toMatch(/<iframe[^>]*\ssrc=/);
      expect(html).not.toContain("data-page-archiver-frame");
      // each frame's own script ran before capture; its result is kept, the script is not
      expect(html).toContain("Rendered by the frame's own script.");
      expect(html).toContain("Same-origin frame, its text set by its own script.");
      expect(html).toContain("Built by the parent");
      expect(html).toContain("Two frames deep, on the other origin.");
    },
  },
  "cookie-wall": {
    check(html) {
      expect(html).not.toContain('id="onetrust-banner-sdk"');
      // refusing is tried before accepting
      expect(html).toMatch(/<body[^>]* data-consent="rejected"/);
    },
  },
  "form-state": {
    check(html) {
      expect(html).toMatch(/<input id="name" type="text" value="Ada Lovelace">/);
      expect(html).not.toContain("hunter2");
      expect(html).toMatch(/<input id="news" type="checkbox" checked="">/);
      expect(html).toMatch(/<input id="terms" type="checkbox">/);
      expect(html).toMatch(/<input type="radio" name="plan" id="pro" checked="">/);
      expect(html).toMatch(/<option selected="">large<\/option>/);
      expect(html).toMatch(/<textarea id="notes">Typed by the reader,\nover two lines.<\/textarea>/);
      expect(html).toMatch(/<details id="more" open="">/);
      expect(html).toMatch(/<input type="submit" value="Send">/);
      expect(count(html, "scroll-initial-target:nearest")).toBe(2);
    },
  },
};

/** Captures url into outDir with core's capture(), reusing the test's browser. */
async function captureFixture(url: string, outDir: string, browser: Browser) {
  return capture(url, { outDir, browser });
}

test("every fixture page has a test", () => {
  expect(Object.keys(FIXTURES).sort()).toEqual(fixturePages());
});

for (const [fixture, spec] of Object.entries(FIXTURES)) {
  test(`${fixture}: the archive opens offline with no requests, no CSP violations, and matches the live page`, async ({
    browser,
  }, testInfo) => {
    const url = fixtureUrl(fixture);

    const dismiss = LIVE_DISMISS[fixture];
    const live = await screenshotLive(browser, url, dismiss ? { dismiss } : {});
    await testInfo.attach("live.png", { body: live, contentType: "image/png" });

    const outDir = testInfo.outputPath("capture");
    const archive = await captureFixture(url, outDir, browser);
    const archiveFile = join(outDir, ARCHIVE_FILE);
    expect(existsSync(archiveFile), `no archive file at ${archiveFile}`).toBe(true);
    const expected = spec.warnings ?? [];
    expect(archive.warnings, "capture warnings").toHaveLength(expected.length);
    expected.forEach((re, i) => expect(archive.warnings[i]).toMatch(re));
    // every byte came from what the page itself loaded: nothing was fetched after the fact (a
    // lazy image the settle step failed to scroll into view would be)
    expect(archive.stats.fetched, "resources fetched after the fact instead of recorded").toBe(0);
    expect(archive.stats.recorded, "resources inlined from the recording").toBeGreaterThan(0);

    const html = readFileSync(archiveFile, "utf8");
    expect(html, "no script survives").not.toMatch(/<script/i);
    expect(html, "no event-handler attribute survives").not.toMatch(/\son[a-z]+\s*=/i);
    expect(verifyStamp(html), "the sha256 stamp matches the file").toBe(true);
    // the summarized warnings are in the file and in the metadata
    expect(archive.meta.warnings).toHaveLength(expected.length);
    expect(archive.meta.bytes.archive).toBe(Buffer.byteLength(html));
    const stamped = readStamp(html)["warnings"];
    expect(stamped === undefined ? [] : JSON.parse(stamped)).toEqual(archive.meta.warnings);
    spec.check?.(html, archive);

    const opened = await openOffline(browser, archiveFile);
    await testInfo.attach("archive.png", { body: opened.screenshot, contentType: "image/png" });
    expect(opened.blocked, "requests the archive made").toEqual([]);
    expect(opened.violations, "CSP violations the archive raised").toEqual([]);

    const diff = diffScreenshots(live, opened.screenshot);
    if (diff.diffPng) await testInfo.attach("diff.png", { body: diff.diffPng, contentType: "image/png" });
    expect(diff.ratio, diff.detail).toBeLessThanOrEqual(MAX_DIFF);
  });
}
