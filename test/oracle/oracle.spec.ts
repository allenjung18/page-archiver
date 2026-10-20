// The oracle: every fixture captured by page-archiver and by SingleFile (single-file-cli, run
// through npx as a separate program; it is AGPL and is never imported or bundled here), each archive
// put through the same offline assertion, and their sizes compared. Each test writes one row;
// table.ts assembles them into test-results/oracle.md after the run. SingleFile's result is
// recorded, never asserted: it is the reference, not the subject.
//
//   npm run oracle
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test, type Browser } from "@playwright/test";
import { ARCHIVE_FILE, capture } from "@page-archiver/core";
import { fixturePages } from "../../fixtures/server.ts";
import { diffScreenshots } from "../e2e/compare.ts";
import { fixtureUrl, VIEWPORT } from "../e2e/env.ts";
import { LIVE_BROKEN, LIVE_DISMISS, screenshotLive } from "../e2e/live.ts";
import { openOffline } from "../e2e/offline.ts";
import { ROWS_DIR, type OracleResult, type OracleRow } from "./table.ts";

/** Pinned: the oracle must not change under the tests. */
export const SINGLEFILE = "single-file-cli@2.18.0";
const MAX_DIFF = 0.01;
const run = promisify(execFile);

async function judge(browser: Browser, file: string, live: Buffer): Promise<OracleResult> {
  const bytes = statSync(file).size;
  const opened = await openOffline(browser, file);
  const diff = diffScreenshots(live, opened.screenshot);
  const problems: string[] = [];
  if (opened.blocked.length) problems.push(`${opened.blocked.length} blocked`);
  if (opened.violations.length) problems.push(`${opened.violations.length} CSP (${[...new Set(opened.violations.map((v) => v.directive))].join(", ")})`);
  if (diff.ratio > MAX_DIFF) problems.push(`diff ${(diff.ratio * 100).toFixed(2)}%`);
  return { pass: problems.length === 0, bytes, diff: diff.ratio, problems };
}

async function singleFile(url: string, out: string): Promise<void> {
  await run(
    "npx",
    [
      "--yes",
      SINGLEFILE,
      url,
      out,
      `--browser-executable-path=${chromium.executablePath()}`,
      `--browser-width=${VIEWPORT.width}`,
      `--browser-height=${VIEWPORT.height}`,
      "--browser-args=[\"--force-device-scale-factor=1\"]",
      "--filename-conflict-action=overwrite",
    ],
    { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
}

for (const fixture of fixturePages()) {
  test(`oracle: ${fixture}`, async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const url = fixtureUrl(fixture);
    const dismiss = LIVE_DISMISS[fixture];
    const broken = LIVE_BROKEN[fixture];
    const live = await screenshotLive(browser, url, { ...(dismiss ? { dismiss } : {}), ...(broken ? { broken } : {}) });

    const oursDir = testInfo.outputPath("ours");
    await capture(url, { outDir: oursDir, browser });
    const ours = await judge(browser, join(oursDir, ARCHIVE_FILE), live);

    const sfFile = testInfo.outputPath("singlefile.html");
    let theirs: OracleResult;
    try {
      await singleFile(url, sfFile);
      theirs = await judge(browser, sfFile, live);
      // a SingleFile page that carries script is reported, since the archive CSP refuses it
      if (/<script/i.test(readFileSync(sfFile, "utf8"))) theirs.problems.push("has <script>");
    } catch (err) {
      theirs = { pass: false, bytes: 0, diff: 1, problems: [`did not run: ${(err as Error).message.split("\n")[0]}`] };
    }

    mkdirSync(ROWS_DIR, { recursive: true });
    const row: OracleRow = { fixture, ours, singlefile: theirs };
    writeFileSync(join(ROWS_DIR, `${fixture}.json`), JSON.stringify(row));
    // our own archive must pass; SingleFile's is only recorded
    expect(ours.problems, `page-archiver on ${fixture}`).toEqual([]);
  });
}
