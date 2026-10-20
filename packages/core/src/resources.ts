// The archive's one way to get a resource's bytes: the recorder first, then (on a miss) a fetch
// through the browser context so the page's cookies still apply. Every failure is a warning,
// never a failed capture. Results are cached, so a URL used twice is read once.
import { MB, type Recorder } from "./recorder.ts";

export interface Resource {
  url: string;
  mime: string;
  bytes: Buffer;
}

/** Fetches what the recorder did not see (Playwright's context.request in a capture). */
export type FallbackFetch = (url: string) => Promise<{ status: number; mime: string; bytes: Buffer }>;

export interface Resolver {
  /** The resource's bytes, or null (and a warning) when it cannot be had. */
  get(url: string): Promise<Resource | null>;
  /** Warnings collected so far, one line each. */
  warnings: string[];
  stats: { recorded: number; fetched: number; failed: number; reused: number };
}

export interface ResolverOptions {
  recorder: Pick<Recorder, "get">;
  fallback?: FallbackFetch;
  resourceCap?: number;
  /** Recorded and fetched bytes together never exceed this. */
  totalCap?: number;
}

export function createResolver(opts: ResolverOptions): Resolver {
  const cache = new Map<string, Promise<Resource | null>>();
  const warnings: string[] = [];
  const stats = { recorded: 0, fetched: 0, failed: 0, reused: 0 };
  const resourceCap = opts.resourceCap ?? 25 * MB;
  const totalCap = opts.totalCap ?? 200 * MB;
  let total = 0;

  function admit(url: string, bytes: Buffer): boolean {
    if (total + bytes.byteLength > totalCap) {
      stats.failed++;
      warnings.push(`${url}: over the ${totalCap / MB} MB total cap; kept as a link`);
      return false;
    }
    total += bytes.byteLength;
    return true;
  }

  async function load(url: string): Promise<Resource | null> {
    const found = await opts.recorder.get(url);
    if (found.kind === "hit") {
      if (!admit(url, found.bytes)) return null;
      stats.recorded++;
      return { url, mime: found.mime, bytes: found.bytes };
    }
    if (found.kind === "unusable" && !found.refetch) {
      stats.failed++;
      warnings.push(`${url}: ${found.reason}; kept as a link`);
      return null;
    }
    if (!opts.fallback) {
      stats.failed++;
      warnings.push(`${url}: not recorded; kept as a link`);
      return null;
    }
    try {
      const res = await opts.fallback(url);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      if (res.bytes.byteLength > resourceCap) throw new Error(`over the per-resource cap`);
      if (!admit(url, res.bytes)) return null;
      stats.fetched++;
      return { url, mime: res.mime, bytes: res.bytes };
    } catch (err) {
      stats.failed++;
      warnings.push(`${url}: fetch failed (${(err as Error).message.split("\n")[0]}); kept as a link`);
      return null;
    }
  }

  return {
    get(url) {
      const cached = cache.get(url);
      if (cached) {
        stats.reused++;
        return cached;
      }
      const p = load(url);
      cache.set(url, p);
      return p;
    },
    warnings,
    stats,
  };
}
