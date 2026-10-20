// Assembles the smoke run's per-page rows into a Markdown report (test-results/smoke.md), run as
// the smoke config's global teardown.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const SMOKE_ROWS_DIR = join(root, "test-results", "smoke-rows");
export const SMOKE_REPORT = join(root, "test-results", "smoke.md");

export interface SmokeRow {
  label: string;
  url: string;
  /** "pass", "FAIL", "miss" (failed as recorded) or "miss passed" (the recorded miss is stale). */
  result: "pass" | "FAIL" | "miss" | "miss passed";
  problems: string[];
  /** The recorded miss's reason. */
  miss?: string;
  /** archive.html's size, 0 when the capture failed. */
  bytes: number;
  /** Fraction of pixels differing between the capture's live screenshot and the archive offline; informative, never asserted. */
  diff: number | null;
  /** CSP violations for resources the capture reported it could not have (kept as links). */
  keptAsLinks: number;
  warnings: string[];
  /** The archive folder, for eyeballing. */
  dir: string;
}

function size(n: number): string {
  if (!n) return "–";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderSmokeReport(rows: readonly SmokeRow[]): string {
  const lines = [
    "| page | result | size | live vs offline | warnings | kept as links | problems |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const diff = r.diff === null ? "–" : `${(r.diff * 100).toFixed(2)}%`;
      const problems = [...r.problems, ...(r.miss ? [`recorded miss: ${r.miss}`] : [])].map(esc).join("; ") || "–";
      return `| [${r.label}](${r.url}) | ${r.result} | ${size(r.bytes)} | ${diff} | ${r.warnings.length} | ${r.keptAsLinks} | ${problems} |`;
    }),
    "",
    "\"live vs offline\" compares the capture's own full-page screenshot with the archive opened offline: real pages",
    "move (carousels, ads, clocks), so it is for reading, not a gate. \"kept as links\" counts the references the",
    "archive refused offline that the capture had already reported it could not load (each one is in the warnings);",
    "they fail the page like any other violation, and a page that fails only on them is usually recorded as a miss.",
    "",
  ];
  for (const r of rows) {
    if (!r.warnings.length) continue;
    lines.push(`### ${r.label}`, "", ...r.warnings.map((w) => `- ${esc(w)}`), "");
  }
  return lines.join("\n");
}

export default function writeSmokeReport(): void {
  if (!existsSync(SMOKE_ROWS_DIR)) return;
  const rows = readdirSync(SMOKE_ROWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(SMOKE_ROWS_DIR, f), "utf8")) as SmokeRow);
  const report = renderSmokeReport(rows);
  writeFileSync(SMOKE_REPORT, report);
  console.log(`\n${report}\nwritten to ${SMOKE_REPORT}`);
}
