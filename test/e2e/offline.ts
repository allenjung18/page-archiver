import { readFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import { ARCHIVE_CSP } from "@page-archiver/core";
import { VIEWPORT } from "./env.ts";

/** Where the archive is served from inside the offline context. Never resolves on a real network. */
export const ARCHIVE_URL = "http://archive.invalid/archive.html";

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
 */
export async function openOffline(
  browser: Browser,
  archiveFile: string,
  opts: { csp?: boolean } = {},
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
      // two frames, so late violation events are dispatched before we read them
      for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const screenshot = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
    return { blocked, violations, screenshot };
  } finally {
    await context.close();
  }
}
