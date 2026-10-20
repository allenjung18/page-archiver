// The project's central test: a captured page must open with the network gone and look like
// the live page did. Written before any capture exists, so until chunk 1 it fails at
// "no archive file".
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ARCHIVE_FILE } from "@page-archiver/core";
import { diffScreenshots } from "./compare.ts";
import { fixtureUrl } from "./env.ts";
import { screenshotLive } from "./live.ts";
import { openOffline } from "./offline.ts";

const FIXTURES = ["plain-article", "lazy-images"] as const;

/** At most this fraction of pixels may differ between the live page and its archive. */
const MAX_DIFF = 0.01;

type CaptureFn = (url: string, opts: { outDir: string }) => Promise<unknown>;

/**
 * Captures url into outDir with core's capture(). Core has no capture() until chunk 1, so this
 * returns false and writes nothing, and the spec fails on the missing archive file: the reason
 * this spec is meant to fail for now. Chunk 1 replaces the lookup with a typed import.
 */
async function captureFixture(url: string, outDir: string): Promise<boolean> {
  const core = (await import("@page-archiver/core")) as Record<string, unknown>;
  const capture = core["capture"];
  if (typeof capture !== "function") return false;
  await (capture as CaptureFn)(url, { outDir });
  return true;
}

for (const fixture of FIXTURES) {
  test(`${fixture}: the archive opens offline with no requests, no CSP violations, and matches the live page`, async ({
    browser,
  }, testInfo) => {
    const url = fixtureUrl(fixture);

    const live = await screenshotLive(browser, url);
    await testInfo.attach("live.png", { body: live, contentType: "image/png" });

    const outDir = testInfo.outputPath("capture");
    const hasCapture = await captureFixture(url, outDir);
    const archiveFile = join(outDir, ARCHIVE_FILE);
    expect(
      existsSync(archiveFile),
      `no archive file at ${archiveFile}` +
        (hasCapture ? "" : " (@page-archiver/core exports no capture() yet)"),
    ).toBe(true);

    const opened = await openOffline(browser, archiveFile);
    await testInfo.attach("archive.png", { body: opened.screenshot, contentType: "image/png" });
    expect(opened.blocked, "requests the archive made").toEqual([]);
    expect(opened.violations, "CSP violations the archive raised").toEqual([]);

    const diff = diffScreenshots(live, opened.screenshot);
    if (diff.diffPng) await testInfo.attach("diff.png", { body: diff.diffPng, contentType: "image/png" });
    expect(diff.ratio, diff.detail).toBeLessThanOrEqual(MAX_DIFF);
  });
}
