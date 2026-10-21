import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { ARCHIVE_CSP } from "@page-archiver/core";
import { VIEWPORT } from "./env.ts";

/**
 * Where the archive is served from inside the offline context. A `.localhost` host, so the page is
 * a secure context as an archive opened from disk (file:) or from `pa serve` (127.0.0.1) is: a
 * request Chromium makes only from one (an `attributionsrc` attribution request) is made here too,
 * and caught. The context is offline, so it never reaches a real server either.
 */
export const ARCHIVE_URL = "http://archive.localhost/archive.html";

export interface CspViolation {
  directive: string;
  blockedURI: string;
  sample: string;
}

export interface OfflineOpen {
  /** Every request the archive made that was not the document itself (data: URLs never get here). */
  blocked: string[];
  /** Every securitypolicyviolation event the archive raised. */
  violations: CspViolation[];
  /** Full-page PNG of the archive as rendered offline. */
  screenshot: Buffer;
}

/**
 * Opens an archive file the way the library will serve it, with the network cut off twice over:
 * the context is offline, and a route aborts every request except the document. The archive is
 * served under ARCHIVE_CSP, so a reference to the network is also a CSP violation.
 * `csp: false` drops the header, which lets the harness's own spec prove the route side alone.
 * `inspect` runs against the loaded page before the screenshot.
 */
export async function openOffline(
  browser: Browser,
  archiveFile: string,
  opts: { csp?: boolean; inspect?: (page: Page) => Promise<void> } = {},
): Promise<OfflineOpen> {
  const body = readFileSync(archiveFile);
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.setOffline(true);
  const blocked: string[] = [];
  const violations: CspViolation[] = [];
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.url() === ARCHIVE_URL && request.isNavigationRequest()) {
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
        if (opts.csp !== false) headers["content-security-policy"] = ARCHIVE_CSP;
        await route.fulfill({ status: 200, headers, body });
        return;
      }
      blocked.push(`${request.resourceType()} ${request.url()}`);
      await route.abort("blockedbyclient");
    });
    await context.exposeBinding("__paCspViolation", (_source, v: CspViolation) => {
      violations.push(v);
    });
    await context.addInitScript(() => {
      const report = (window as unknown as { __paCspViolation: (v: unknown) => void })
        .__paCspViolation;
      document.addEventListener("securitypolicyviolation", (e) => {
        report({ directive: e.effectiveDirective, blockedURI: e.blockedURI, sample: e.sample });
      });
    });
    const page = await context.newPage();
    const response = await page.goto(ARCHIVE_URL, { waitUntil: "load" });
    if (response?.status() !== 200) throw new Error(`archive did not load: ${response?.status()}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      await document.fonts.ready;
      // decoding="async" images below the fold may not be painted yet: a full-page screenshot
      // would show them blank although the archive has them
      const decodes = [...document.images].map((img) => img.decode().catch(() => undefined));
      await Promise.race([Promise.all(decodes), new Promise((r) => setTimeout(r, 5_000))]);
      // two frames, so late violation events are dispatched before we read them
      for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    if (opts.inspect) await opts.inspect(page);
    const screenshot = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
    return { blocked, violations, screenshot };
  } finally {
    await context.close();
  }
}
