import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openLibrary, type Library } from "./library.ts";

// scanLibrary as it is, with a hook that runs when it is called: what the index's connection was
// doing then, and a stand-in for another process changing the folders after the scan
const probe = vi.hoisted(() => ({ db: null as Database.Database | null, inTransaction: [] as boolean[], after: null as null | ((r: { entries: { dir: string }[] }) => void) }));
vi.mock("./layout.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./layout.ts")>();
  return {
    ...real,
    scanLibrary: (root: string) => {
      if (probe.db) probe.inTransaction.push(probe.db.inTransaction);
      const result = real.scanLibrary(root);
      probe.after?.(result);
      return result;
    },
  };
});

const page = (title: string, word: string, savedAt: string) => `<!DOCTYPE html><html lang="en"><!--
 Page saved with SingleFile
 url: https://x.example/${word}
 saved date: ${savedAt}
--><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>The ${word} is in this one, with enough ordinary prose around it about tides and weather that a reader view keeps it.</p></article></body></html>`;

let tmp: string;
let lib: Library;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "pa-db-"));
  lib = openLibrary(join(tmp, "lib"));
  for (const [i, w] of ["quillet", "brandle"].entries()) {
    const f = join(tmp, `${w}.html`);
    writeFileSync(f, page(`Page ${i}`, w, `2026-0${i + 1}-01T00:00:00Z`));
    await lib.importFile(f);
  }
  probe.db = lib.db;
  probe.inTransaction.length = 0;
  probe.after = null;
});

afterEach(() => {
  probe.db = null;
  lib.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("rebuilding the index", () => {
  it("reads the folders before it takes the write lock, so a long scan holds up no other writer", () => {
    expect(lib.reindex().indexed).toBe(2);
    expect(probe.inTransaction, "inside a transaction when the folders were scanned").toEqual([false]);
  });

  it("keeps a page another process added after the scan, and drops one it removed", async () => {
    const f = join(tmp, "late.html");
    writeFileSync(f, page("Late", "gorsemoth", "2026-03-01T00:00:00Z"));
    const late = await lib.importFile(f);
    const gone = lib.search("quillet")[0]!;
    probe.after = (result) => {
      // the scan missed the late page (it was written after), and still saw the removed one
      result.entries = result.entries.filter((e) => e.dir !== late.dir);
      renameSync(join(lib.root, gone.dir), join(lib.root, `.deleting-${gone.id}-1`));
    };
    lib.reindex();
    expect(lib.search("gorsemoth").map((p) => p.id), "the page added after the scan").toEqual([late.id]);
    expect(lib.search("quillet"), "the page removed after the scan").toEqual([]);
  });
});
