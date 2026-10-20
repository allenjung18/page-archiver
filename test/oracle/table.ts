// Assembles the oracle's per-fixture rows into a Markdown table (test-results/oracle.md), run as
// the oracle config's global teardown.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const ROWS_DIR = join(root, "test-results", "oracle-rows");
export const TABLE_FILE = join(root, "test-results", "oracle.md");

export interface OracleResult {
  pass: boolean;
  bytes: number;
  /** Fraction of pixels differing from the live page. */
  diff: number;
  problems: string[];
}

export interface OracleRow {
  fixture: string;
  ours: OracleResult;
  singlefile: OracleResult;
}

function kb(n: number): string {
  return n ? `${(n / 1024).toFixed(1)} KB` : "–";
}

function cell(r: OracleResult): string {
  return r.pass ? `pass (${(r.diff * 100).toFixed(2)}%)` : `FAIL: ${r.problems.join("; ")}`;
}

export function renderTable(rows: readonly OracleRow[]): string {
  const lines = [
    "| fixture | page-archiver | size | SingleFile | size | ours / theirs |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const ratio = r.singlefile.bytes ? `${(r.ours.bytes / r.singlefile.bytes).toFixed(2)}x` : "–";
      return `| ${r.fixture} | ${cell(r.ours)} | ${kb(r.ours.bytes)} | ${cell(r.singlefile)} | ${kb(r.singlefile.bytes)} | ${ratio} |`;
    }),
  ];
  return lines.join("\n") + "\n";
}

export default function writeTable(): void {
  if (!existsSync(ROWS_DIR)) return;
  const rows = readdirSync(ROWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ROWS_DIR, f), "utf8")) as OracleRow);
  const table = renderTable(rows);
  writeFileSync(TABLE_FILE, table);
  console.log(`\n${table}\nwritten to ${TABLE_FILE}`);
}
