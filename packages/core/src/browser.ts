// Chromium for a capture: a fixed 1280x900 viewport at device scale 1 (so srcset choices and
// layout match what the tests compare against), and bypassCSP so the injected serializer runs on
// pages with a strict Content-Security-Policy. A profile directory gives a persistent, logged-in
// browser; without one every capture starts clean.
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright";

export const VIEWPORT = { width: 1280, height: 900 } as const;

export function contextOptions(): BrowserContextOptions {
  return { viewport: { ...VIEWPORT }, deviceScaleFactor: 1, bypassCSP: true };
}

export interface BrowserOptions {
  /** A persistent profile (cookies, logins) to capture with. */
  profileDir?: string | undefined;
  /** Show the browser window. Default false. */
  headed?: boolean | undefined;
  /** Reuse this browser (a new context in it) instead of launching one. Ignored with profileDir. */
  browser?: Browser | undefined;
}

export interface BrowserSession {
  context: BrowserContext;
  /** Closes what this session opened (never a browser passed in). */
  close(): Promise<void>;
}

export async function openBrowser(opts: BrowserOptions = {}): Promise<BrowserSession> {
  if (opts.profileDir) {
    const context = await chromium.launchPersistentContext(opts.profileDir, { ...contextOptions(), headless: !opts.headed });
    return { context, close: () => context.close() };
  }
  if (opts.browser) {
    const context = await opts.browser.newContext(contextOptions());
    return { context, close: () => context.close() };
  }
  const browser = await chromium.launch({ headless: !opts.headed });
  try {
    const context = await browser.newContext(contextOptions());
    return { context, close: () => browser.close() };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
