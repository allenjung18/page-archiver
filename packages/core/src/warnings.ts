// A capture's warnings, one line per problem, and the short form that goes into the archive's
// metadata: problems of the same kind (resources over a cap, resources that could not be had)
// counted on one line, so a page with 300 missing images says so once.

/** An archive larger than this gets a warning (it still saves). */
export const LARGE_ARCHIVE_BYTES = 50 * 1024 * 1024;

const KINDS: Array<{ test: RegExp; line: (n: number) => string }> = [
  { test: /: over the [\d.]+ MB per-resource cap/, line: (n) => `${n} ${plural(n, "resource")} over the per-resource size cap, kept as links` },
  { test: /: over the [\d.]+ MB total cap/, line: (n) => `${n} ${plural(n, "resource")} over the page's total size cap, kept as links` },
  { test: /: (fetch failed|not recorded|HTTP \d+|body unavailable)/, line: (n) => `${n} ${plural(n, "resource")} could not be loaded, kept as links` },
];

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** The warnings for metadata: kinds above counted, everything else as it is, in first-seen order. */
export function summarizeWarnings(warnings: readonly string[]): string[] {
  const counts = new Map<number, number>();
  const out: Array<string | number> = [];
  for (const w of warnings) {
    const k = KINDS.findIndex((kind) => kind.test.test(w));
    if (k === -1) {
      if (!out.includes(w)) out.push(w);
      continue;
    }
    if (!counts.has(k)) out.push(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return out.map((x) => (typeof x === "number" ? KINDS[x]!.line(counts.get(x)!) : x));
}

/** The warning for an archive of `bytes` bytes, or null when it is not large. */
export function sizeWarning(bytes: number, limit = LARGE_ARCHIVE_BYTES): string | null {
  if (bytes <= limit) return null;
  return `the archive is ${(bytes / 1024 / 1024).toFixed(1)} MB (over ${Math.round(limit / 1024 / 1024)} MB)`;
}
