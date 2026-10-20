// The project's central test: a captured page must open with the network gone and look like
// the live page did.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { ARCHIVE_FILE, capture, verifyStamp } from "@page-archiver/core";
import { diffScreenshots } from "./compare.ts";
import { fixtureUrl } from "./env.ts";
import { screenshotLive } from "./live.ts";
import { openOffline } from "./offline.ts";

const FIXTURES = ["plain-article", "lazy-images", "import-chain", "spa"] as const;

/** At most this fraction of pixels may differ between the live page and its archive. */
const MAX_DIFF = 0.01;

/** Warnings a fixture is built to raise; any other capture warning fails the test. */
const EXPECTED_WARNINGS: Partial<Record<(typeof FIXTURES)[number], RegExp[]>> = {
  // shared/type.css imports chain/main.css back; browsers drop that import, and so does capture
  "import-chain": [/css\/shared\/type\.css: @import \S+\/css\/chain\/main\.css is a cycle; dropped$/],
};

/** Captures url into outDir with core's capture(), reusing the test's browser. */
async function captureFixture(url: string, outDir: string, browser: Browser) {
  return capture(url, { outDir, browser });
}

for (const fixture of FIXTURES) {
  test(`${fixture}: the archive opens offline with no requests, no CSP violations, and matches the live page`, async ({
    browser,
  }, testInfo) => {
    const url = fixtureUrl(fixture);

    const live = await screenshotLive(browser, url);
    await testInfo.attach("live.png", { body: live, contentType: "image/png" });

    const outDir = testInfo.outputPath("capture");
    const archive = await captureFixture(url, outDir, browser);
    const archiveFile = join(outDir, ARCHIVE_FILE);
    expect(existsSync(archiveFile), `no archive file at ${archiveFile}`).toBe(true);
    const expected = EXPECTED_WARNINGS[fixture] ?? [];
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

    const opened = await openOffline(browser, archiveFile);
    await testInfo.attach("archive.png", { body: opened.screenshot, contentType: "image/png" });
    expect(opened.blocked, "requests the archive made").toEqual([]);
    expect(opened.violations, "CSP violations the archive raised").toEqual([]);

    const diff = diffScreenshots(live, opened.screenshot);
    if (diff.diffPng) await testInfo.attach("diff.png", { body: diff.diffPng, contentType: "image/png" });
    expect(diff.ratio, diff.detail).toBeLessThanOrEqual(MAX_DIFF);
  });
}
