import { expect, type Browser, type Page } from "@playwright/test";
import { VIEWPORT } from "./env.ts";

/**
 * Settles a live page the way a capture does: load, network idle, scroll to the bottom in
 * viewport steps so lazy content arrives, back to the top, fonts ready.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle");
  await page.evaluate(async (step) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await frame();
      await frame();
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await frame();
  }, VIEWPORT.height);
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  });
}

/** Fixtures whose reader clicks something first: the live reference is the page after that click. */
export const LIVE_DISMISS: Readonly<Record<string, string>> = {
  "cookie-wall": "#onetrust-reject-all-handler",
};

/**
 * Opens a fixture live, settles it, checks every image loaded, and returns a full-page PNG.
 * `dismiss` is clicked first, the way a reader closes a consent wall before reading.
 */
export async function screenshotLive(browser: Browser, url: string, opts: { dismiss?: string } = {}): Promise<Buffer> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load" });
    if (opts.dismiss) await page.click(opts.dismiss);
    await settle(page);
    const broken = await page.evaluate(() =>
      [...document.images]
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute("src") ?? img.getAttribute("data-src") ?? "(no src)"),
    );
    expect(broken, `images that did not load on the live page ${url}`).toEqual([]);
    return await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
  } finally {
    await context.close();
  }
}
