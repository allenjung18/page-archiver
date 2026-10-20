// Waits until the page is as complete as it is going to get: load, network idle (500 ms with
// nothing in flight, each wait capped at 15 s so a long-poll cannot hang a capture), an optional
// selector, consent banners dismissed, a scroll to the bottom in viewport steps so lazy images
// and first infinite-scroll pages load, idle again, back to the top, fonts ready.
import type { Page } from "playwright";

export const IDLE_QUIET_MS = 500;
export const IDLE_CAP_MS = 15_000;
/** At most this many viewport steps: an infinite-scroll page never reaches the bottom. */
export const MAX_SCROLL_STEPS = 60;

interface RequestEvents {
  on(event: "request" | "requestfinished" | "requestfailed", fn: (r: unknown) => void): unknown;
  off(event: "request" | "requestfinished" | "requestfailed", fn: (r: unknown) => void): unknown;
}

export interface NetworkTracker {
  inflight(): number;
  /** Resolves true once nothing has been in flight for quietMs, or false when capMs runs out first. */
  waitForIdle(quietMs?: number, capMs?: number): Promise<boolean>;
  dispose(): void;
}

/** Counts requests in flight on page (data: URLs never reach these events). */
export function trackNetwork(page: RequestEvents, now: () => number = Date.now): NetworkTracker {
  const pending = new Set<unknown>();
  let lastChange = now();
  const listeners: Array<() => void> = [];
  const changed = () => {
    lastChange = now();
    for (const l of listeners.splice(0)) l();
  };
  const onRequest = (r: unknown) => {
    pending.add(r);
    changed();
  };
  const onDone = (r: unknown) => {
    if (pending.delete(r)) changed();
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);

  return {
    inflight: () => pending.size,
    waitForIdle(quietMs = IDLE_QUIET_MS, capMs = IDLE_CAP_MS) {
      const deadline = now() + capMs;
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (idle: boolean) => {
          const i = listeners.indexOf(check);
          if (i !== -1) listeners.splice(i, 1);
          resolve(idle);
        };
        const check = () => {
          clearTimeout(timer);
          const t = now();
          if (pending.size === 0 && t - lastChange >= quietMs) return finish(true);
          if (t >= deadline) return finish(false);
          const wait = pending.size === 0 ? Math.min(quietMs - (t - lastChange), deadline - t) : deadline - t;
          timer = setTimeout(check, Math.max(1, wait));
          if (!listeners.includes(check)) listeners.push(check);
        };
        check();
      });
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    },
  };
}

export interface SettleOptions {
  /** Wait for this selector after load (a client-rendered page's content). */
  waitFor?: string | undefined;
  /** Click each of these when visible (cookie and consent banners). */
  dismiss?: readonly string[] | undefined;
  idleQuietMs?: number | undefined;
  idleCapMs?: number | undefined;
  /** How long --wait-for may take. Default 15 s. */
  waitForTimeoutMs?: number | undefined;
}

/** Settles a page that has fired load. Returns warnings (an idle cap hit, a selector that never came). */
export async function settle(page: Page, network: NetworkTracker, opts: SettleOptions = {}): Promise<string[]> {
  const warnings: string[] = [];
  const quiet = opts.idleQuietMs ?? IDLE_QUIET_MS;
  const cap = opts.idleCapMs ?? IDLE_CAP_MS;
  const idle = async (phase: string) => {
    if (!(await network.waitForIdle(quiet, cap))) warnings.push(`network not idle after ${cap / 1000} s (${phase}); captured anyway`);
  };

  await idle("after load");
  if (opts.waitFor) {
    try {
      await page.waitForSelector(opts.waitFor, { state: "attached", timeout: opts.waitForTimeoutMs ?? 15_000 });
    } catch {
      warnings.push(`--wait-for ${opts.waitFor} never appeared; captured anyway`);
    }
    await idle("after wait-for");
  }
  for (const selector of opts.dismiss ?? []) {
    try {
      const target = page.locator(selector).first();
      if (await target.isVisible()) await target.click({ timeout: 2_000 });
    } catch {
      warnings.push(`--dismiss ${selector} could not be clicked`);
    }
  }

  const steps = await page.evaluate(
    async ({ maxSteps }) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      const step = window.innerHeight;
      let n = 0;
      for (let y = 0; y < document.documentElement.scrollHeight && n < maxSteps; y += step, n++) {
        window.scrollTo(0, y);
        await frame();
        await frame();
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await frame();
      return n;
    },
    { maxSteps: MAX_SCROLL_STEPS },
  );
  if (steps >= MAX_SCROLL_STEPS) warnings.push(`scrolled ${MAX_SCROLL_STEPS} screens and stopped (endless page?)`);
  await idle("after scrolling");

  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    const decodes = [...document.images].map((img) => img.decode().catch(() => undefined));
    await Promise.race([Promise.all(decodes), new Promise((r) => setTimeout(r, 5_000))]);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
  return warnings;
}
