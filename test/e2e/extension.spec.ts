// The Chrome extension end to end, in a real Chromium with only this extension loaded (a
// throwaway profile; see extension.ts): the popup saves a fixture page into a test library
// through the library server, and with no server running the same save downloads archive.html,
// which must pass the offline assertion and look like the live page.
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { verifyStamp, readStamp } from "@page-archiver/core";
import { startServer } from "@page-archiver/server";
import { diffScreenshots } from "./compare.ts";
import { fixtureUrl } from "./env.ts";
import { launchWithExtension } from "./extension.ts";
import { screenshotLive, settle } from "./live.ts";
import { openOffline } from "./offline.ts";

/** At most this fraction of pixels may differ between the live page and its archive. */
const MAX_DIFF = 0.01;

/** A local port nothing listens on (bound, then let go). */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

test("the popup saves a fixture page into the library through the server, with its tags, and it opens offline", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const server = await startServer({ library: testInfo.outputPath("library"), port: 0 });
  const ext = await launchWithExtension();
  try {
    await ext.setServer(server.url);
    const url = fixtureUrl("import-chain");
    const page = await ext.context.newPage();
    await page.goto(url);
    await settle(page);
    const tabId = await ext.tabId(page);

    const popup = await ext.openPopup(tabId);
    await expect(popup.locator("#page")).toHaveText("An @import chain");
    await popup.locator("#tags").fill("fixtures, extension fixtures");
    await popup.locator("#save").click();
    await expect(popup.locator("#status")).toHaveText(/^Saved ✓/, { timeout: 60_000 });

    const pages = server.library.list();
    expect(pages).toHaveLength(1);
    const saved = pages[0]!;
    expect(saved).toMatchObject({ url, tags: ["fixtures", "extension"], version: 1 });
    const html = readFileSync(server.library.pathOf(saved), "utf8");
    expect(html, "no script survives").not.toMatch(/<script/i);
    expect(verifyStamp(html), "the stamp matches the file").toBe(true);
    expect(readStamp(html)["source-url"]).toBe(url);
    // the import chain's cycle is the only warning, as for a capture by `pa save`
    const meta = JSON.parse(readFileSync(server.library.pathOf(saved, "meta.json"), "utf8")) as { warnings: string[] };
    expect(meta.warnings).toEqual([expect.stringMatching(/css\/shared\/type\.css: @import \S+\/css\/chain\/main\.css is a cycle; dropped$/)]);

    const opened = await openOffline(browser, server.library.pathOf(saved));
    expect(opened.blocked, "requests the archive made").toEqual([]);
    expect(opened.violations, "CSP violations the archive raised").toEqual([]);

    // "Open in library" opens the reader UI; the popup opened again still says it is saved
    const [library] = await Promise.all([ext.context.waitForEvent("page"), popup.locator("#open").click()]);
    await expect(library).toHaveURL(server.url);
    await popup.close();
    const again = await ext.openPopup(tabId);
    await expect(again.locator("#status")).toHaveText(/^Saved ✓/);
    await expect(again.locator("#open")).toBeVisible();
  } finally {
    await ext.close();
    await server.close();
  }
});

test("the popup saves the page as the tab had it, not as the server would fetch it", async (_fixtures, testInfo) => {
  test.setTimeout(120_000);
  // a loopback page that writes its text from this tab's sessionStorage: a fresh load (the
  // server's own fetch, in its own browser) has none, and shows "no note"
  const origin = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><title>Signed-in Notes</title><article><h1>Signed-in Notes</h1><p id="note"></p><p>${"The page keeps its notes in the tab. ".repeat(20)}</p></article>` +
        `<script>window.show = () => { document.getElementById("note").textContent = sessionStorage.getItem("note") || "no note"; }; window.show();</script>`,
    );
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(origin.address() as { port: number }).port}/notes`;
  const server = await startServer({ library: testInfo.outputPath("library"), port: 0 });
  const ext = await launchWithExtension();
  try {
    await ext.setServer(server.url);
    const page = await ext.context.newPage();
    await page.goto(url);
    await page.evaluate(() => {
      sessionStorage.setItem("note", "the tab-only note quillfeather");
      (window as unknown as { show(): void }).show();
    });
    const tabId = await ext.tabId(page);
    const popup = await ext.openPopup(tabId);
    await popup.locator("#save").click();
    await expect(popup.locator("#status")).toHaveText(/^Saved ✓/, { timeout: 60_000 });

    const [saved] = server.library.list();
    const html = readFileSync(server.library.pathOf(saved!), "utf8");
    expect(html, "the text only this tab had").toContain("the tab-only note quillfeather");
    expect(html).not.toContain("no note");
    expect(server.library.search("quillfeather").map((h) => h.url)).toEqual([url]);
  } finally {
    await ext.close();
    await server.close();
    origin.close();
    origin.closeAllConnections();
  }
});

/** Occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string | RegExp) => hay.split(needle).length - 1;

/** What each downloaded archive must hold besides opening offline (the same as offline.spec.ts asks of a capture). */
const CHECKS: Record<string, (html: string) => void> = {
  "web-fonts": (html) => {
    // only the loaded latin face, and of its src list only the woff2 the page fetched
    expect(count(html, /@font-face\s*\{/)).toBe(1);
    expect(count(html, "data:font/woff2;base64,")).toBe(1);
    expect(html).not.toContain("data:font/woff;base64,");
  },
  iframes: (html) => {
    // every frame, the cross-origin ones and the one two deep included, is in the file as srcdoc
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/);
    expect(html).not.toContain("data-page-archiver-frame");
    expect(html).toContain("Rendered by the frame's own script.");
    expect(html).toContain("Same-origin frame, its text set by its own script.");
    expect(html).toContain("Built by the parent");
    expect(html).toContain("Two frames deep, on the other origin.");
  },
};

for (const fixture of Object.keys(CHECKS)) {
  test(`${fixture}: with no server running the popup downloads archive.html, which opens offline and matches the live page`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const url = fixtureUrl(fixture);
    const live = await screenshotLive(browser, url);
    const ext = await launchWithExtension();
    try {
      await ext.setServer(`http://127.0.0.1:${await closedPort()}/`);
      const page = await ext.context.newPage();
      await page.goto(url);
      await settle(page);
      const tabId = await ext.tabId(page);

      const popup = await ext.openPopup(tabId);
      await popup.locator("#save").click();
      await expect(popup.locator("#status")).toHaveText(/^Downloaded \S+\.html instead: the library server is not running/, { timeout: 60_000 });
      const result = await ext.worker.evaluate(
        async (key) => (await (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome.storage.session.get(key))[key],
        `result:${tabId}`,
      ) as { kind: string; downloadId: number; filename: string; warnings: string[] };
      expect(result.kind).toBe("downloaded");
      const file = await ext.downloaded(result.downloadId);
      expect(file.startsWith(ext.downloads), `${file} is in the profile's own downloads folder`).toBe(true);

      const html = readFileSync(file, "utf8");
      expect(html, "no script survives").not.toMatch(/<script/i);
      expect(html, "no event-handler attribute survives").not.toMatch(/\son[a-z]+\s*=/i);
      expect(verifyStamp(html), "the stamp matches the file").toBe(true);
      expect(readStamp(html)["source-url"]).toBe(url);
      expect(result.warnings, "capture warnings").toEqual([]);
      CHECKS[fixture]!(html);

      const opened = await openOffline(browser, file);
      await testInfo.attach("archive.png", { body: opened.screenshot, contentType: "image/png" });
      expect(opened.blocked, "requests the archive made").toEqual([]);
      expect(opened.violations, "CSP violations the archive raised").toEqual([]);
      const diff = diffScreenshots(live, opened.screenshot);
      if (diff.diffPng) await testInfo.attach("diff.png", { body: diff.diffPng, contentType: "image/png" });
      expect(diff.ratio, diff.detail).toBeLessThanOrEqual(MAX_DIFF);
    } finally {
      await ext.close();
    }
  });
}
