// The real-site smoke run: every page in test/smoke-urls.txt captured from the live web, then put
// through the offline assertion (test/e2e/offline.ts): zero blocked requests, zero CSP
// violations, and the expected text present, which proves the archive holds the page and not a
// bot wall or an error page. Violations for resources the capture reported it could not have (kept
// as links) fail the page like any other and are counted apart in the report. Each test writes one
// row, a provisional one first so that a test that throws or times out is still reported;
// table.ts assembles them into test-results/smoke.md, with each capture's warnings, after the run.
//
// Opt-in and never part of `npm test` or `npm run test:e2e`: it reaches the network.
//
//   npm run smoke                     every page
//   npm run smoke -- -g recipe        one page, by label
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { capture, type Archive } from "@page-archiver/core";
import { diffScreenshots } from "../e2e/compare.ts";
import { openOffline, type OfflineOpen } from "../e2e/offline.ts";
import { normalizeText, readSmokeList, splitViolations } from "./list.ts";
import { SMOKE_ROWS_DIR, type SmokeRow } from "./table.ts";

for (const page of readSmokeList()) {
  test(`smoke: ${page.label}`, async ({ browser }, testInfo) => {
    test.setTimeout(300_000);
    if (page.miss) test.fail(true, `recorded miss: ${page.miss}`);
    const dir = testInfo.outputPath("capture");
    const problems: string[] = [];
    let archive: Archive | undefined;
    let opened: OfflineOpen | undefined;
    let text = "";
    let keptAsLinks = 0;
    const writeRow = (row: SmokeRow) => {
      if (page.miss) row.miss = page.miss;
      mkdirSync(SMOKE_ROWS_DIR, { recursive: true });
      writeFileSync(join(SMOKE_ROWS_DIR, `${page.label}.json`), JSON.stringify(row));
    };
    // overwritten below; stays only when the test throws or times out before it gets there
    writeRow({
      label: page.label,
      url: page.url,
      result: page.miss ? "miss" : "FAIL",
      problems: ["the test did not finish (an error or its time limit); see the Playwright output"],
      bytes: 0,
      diff: null,
      keptAsLinks: 0,
      warnings: [],
      dir,
    });
    try {
      archive = await capture(page.url, { outDir: dir, browser, extras: { reader: true, png: true, mhtml: false, pdf: false } });
    } catch (err) {
      problems.push(`capture failed: ${(err as Error).message.split("\n")[0]}`);
    }
    if (archive?.file) {
      try {
        opened = await openOffline(browser, archive.file, {
          inspect: async (p) => {
            text = await p.evaluate(() => `${document.title}\n${document.body?.innerText ?? ""}`);
          },
        });
      } catch (err) {
        problems.push(`the archive did not open offline: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    if (archive && opened) {
      if (opened.blocked.length) problems.push(`${opened.blocked.length} blocked: ${opened.blocked.slice(0, 3).join(", ")}`);
      // every violation fails the page, as in the offline assertion; those for resources the
      // capture reported it could not have (kept as links) are named apart, since their cause is
      // the site, not a reference the capture missed
      const { reported, unreported } = splitViolations(opened.violations, archive.warnings);
      const list = (vs: typeof unreported) => vs.slice(0, 3).map((x) => `${x.directive} ${x.blockedURI || x.sample}`).join(", ");
      if (unreported.length) problems.push(`${unreported.length} CSP violations: ${list(unreported)}`);
      if (reported.length) problems.push(`${reported.length} CSP violations for resources kept as links: ${list(reported)}`);
      keptAsLinks = reported.length;
      if (!normalizeText(text).includes(normalizeText(page.expect))) problems.push(`the archive does not contain ${JSON.stringify(page.expect)}`);
    }

    const diff = archive?.png && opened ? diffScreenshots(archive.png, opened.screenshot).ratio : null;
    const failed = problems.length > 0;
    writeRow({
      label: page.label,
      url: page.url,
      result: page.miss ? (failed ? "miss" : "miss passed") : failed ? "FAIL" : "pass",
      problems,
      bytes: archive ? Buffer.byteLength(archive.html) : 0,
      diff,
      keptAsLinks,
      warnings: archive?.warnings ?? [],
      dir,
    });
    expect(problems, `${page.label} (${page.url})`).toEqual([]);
  });
}
