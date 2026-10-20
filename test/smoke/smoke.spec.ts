// The real-site smoke run: every page in test/smoke-urls.txt captured from the live web, then put
// through the offline assertion (test/e2e/offline.ts): zero blocked requests, zero CSP
// violations, and the expected text present, which proves the archive holds the page and not a
// bot wall or an error page. A violation for a URL the capture warned about (a resource the site
// would not give, kept as a link) is counted in the report but does not fail the page. Each test writes one row; table.ts assembles them into
// test-results/smoke.md, with each capture's warnings, after the run.
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
    try {
      archive = await capture(page.url, { outDir: dir, browser, extras: { reader: true, png: true, mhtml: false, pdf: false } });
    } catch (err) {
      problems.push(`capture failed: ${(err as Error).message.split("\n")[0]}`);
    }
    if (archive?.file) {
      opened = await openOffline(browser, archive.file, {
        inspect: async (p) => {
          text = await p.evaluate(() => `${document.title}\n${document.body?.innerText ?? ""}`);
        },
      });
      if (opened.blocked.length) problems.push(`${opened.blocked.length} blocked: ${opened.blocked.slice(0, 3).join(", ")}`);
      // a reference the capture already reported (a resource that could not be had, kept as a
      // link) is the documented outcome, not a miss; only an unreported one fails the page
      const { reported, unreported } = splitViolations(opened.violations, archive.warnings);
      if (unreported.length) {
        const v = unreported.slice(0, 3).map((x) => `${x.directive} ${x.blockedURI || x.sample}`);
        problems.push(`${unreported.length} CSP violations: ${v.join(", ")}`);
      }
      keptAsLinks = reported.length;
      if (!normalizeText(text).includes(normalizeText(page.expect))) problems.push(`the archive does not contain ${JSON.stringify(page.expect)}`);
    }

    const diff = archive?.png && opened ? diffScreenshots(archive.png, opened.screenshot).ratio : null;
    const failed = problems.length > 0;
    const row: SmokeRow = {
      label: page.label,
      url: page.url,
      result: page.miss ? (failed ? "miss" : "miss passed") : failed ? "FAIL" : "pass",
      problems,
      bytes: archive ? Buffer.byteLength(archive.html) : 0,
      diff,
      keptAsLinks,
      warnings: archive?.warnings ?? [],
      dir,
    };
    if (page.miss) row.miss = page.miss;
    mkdirSync(SMOKE_ROWS_DIR, { recursive: true });
    writeFileSync(join(SMOKE_ROWS_DIR, `${page.label}.json`), JSON.stringify(row));
    expect(problems, `${page.label} (${page.url})`).toEqual([]);
  });
}
