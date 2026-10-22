// The library end to end through the built `pa`: every fixture page (every capture fixture
// saved with `pa save`, plus the SingleFile saves in fixtures/import brought in with `pa
// import`) in a library in the test's own output folder; search, a rebuilt index, versions,
// tags and `pa open`. Every command names its library, and PA_LIBRARY points there too, so no
// test can reach the default ~/Archive/pages.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { verifyStamp, type PageMeta } from "@page-archiver/core";
import type { PageRecord, SearchHit } from "@page-archiver/library";
import { fixturePages } from "../../fixtures/server.ts";
import { fixtureUrl } from "./env.ts";
import { openOffline } from "./offline.ts";

const execFileP = promisify(execFile);
const PA = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/import/", import.meta.url));

/** The invented word each import fixture holds and no other fixture does. */
const IMPORT_WORDS: Record<string, string> = {
  "sourdough-starter": "wobbleloaf",
  "chain-wear": "quindlesprocket",
  "moss-garden": "frondlemist",
  "review-lantern-coast": "glimmerhaw",
  "night-train-notes": "drowsenhalt",
  "http-caching-guide": "plinkerstash",
};

/** Runs `pa` against the library at lib; resolves with its output whatever its exit code. */
async function pa(lib: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [PA, ...args, "--library", lib], { env: { ...process.env, PA_LIBRARY: lib }, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

async function ok(lib: string, ...args: string[]): Promise<string> {
  const r = await pa(lib, ...args);
  expect(r.code, `pa ${args.join(" ")}\n${r.stderr}`).toBe(0);
  return r.stdout;
}

const json = <T>(s: string): T => JSON.parse(s) as T;

/** Runs the jobs at most `n` at a time. */
async function pool<T>(items: readonly T[], n: number, job: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await job(item);
  }));
}

test("a library of every fixture page (20 or more): search finds a word in one article, and a deleted index rebuilds to the same results", async ({ browser }) => {
  test.setTimeout(360_000);
  const lib = test.info().outputPath("library");
  const pages = fixturePages();
  const imports = readdirSync(IMPORT_DIR).filter((f) => f.endsWith(".html")).sort();
  const total = pages.length + imports.length;
  expect(total).toBeGreaterThanOrEqual(20);

  await pool(pages, 4, async (name) => {
    const out = await ok(lib, "save", fixtureUrl(name), "--no-mhtml", "--no-shot");
    expect(out).toMatch(/^saved [0-9a-z]{12} \(version 1 of 1\) /);
  });
  const imported = await ok(lib, "import", ...imports.map((f) => join(IMPORT_DIR, f)));
  expect(imported.trim().split("\n")).toHaveLength(6);

  const list = json<PageRecord[]>(await ok(lib, "list", "--json"));
  expect(list).toHaveLength(total);
  expect(new Set(list.map((p) => p.url)).size).toBe(total);
  for (const p of list) {
    expect(p.dir).toMatch(/^\d{4}\/\d{2}\/[a-z0-9-]+-[0-9a-z]{12}$/);
    expect(p.dir.endsWith(p.id)).toBe(true);
    expect(existsSync(join(lib, p.dir, "archive.html"))).toBe(true);
    expect(existsSync(join(lib, p.dir, "meta.json"))).toBe(true);
  }

  // a word that appears in only one archived article finds that article and nothing else
  const queries: Array<[string, string]> = [["parish", fixtureUrl("plain-article")], ["gallery", fixtureUrl("news-article")]];
  for (const [file, word] of Object.entries(IMPORT_WORDS)) {
    const url = readFileSync(join(IMPORT_DIR, `${file}.html`), "utf8").match(/^ url: (\S+)/m)![1]!;
    queries.push([word, url]);
  }
  const before: string[] = [];
  for (const [word, url] of queries) {
    const out = await ok(lib, "search", word, "--json");
    const hits = json<SearchHit[]>(out);
    expect(hits.map((h) => h.url), word).toEqual([url]);
    expect(hits[0]!.snippet.toLowerCase()).toContain(`[${word}]`);
    before.push(out);
  }
  const text = await ok(lib, "search", "parish");
  expect(text).toMatch(/^[0-9a-z]{12} {2}\d{4}-\d{2}-\d{2} {2}v1\/1 {2}.+The Lighthouse Keeper's Ledger\n {4}.*\[parish\]/);
  const none = await pa(lib, "search", "nowhereword");
  expect(none).toMatchObject({ code: 1, stdout: "" });
  const listBefore = await ok(lib, "list", "--json", "--all");

  // delete library.db, reindex, and the same searches give the same results
  rmSync(join(lib, "library.db"));
  expect(await ok(lib, "reindex")).toBe(`indexed ${total} pages in ${lib}\n`);
  const after: string[] = [];
  for (const [word] of queries) after.push(await ok(lib, "search", word, "--json"));
  expect(after).toEqual(before);
  expect(await ok(lib, "list", "--json", "--all")).toBe(listBefore);

  // an imported page is as offline as a captured one
  const sourdough = list.find((p) => p.url === "https://bakery.example/notes/sourdough-starter")!;
  const archive = join(lib, sourdough.dir, "archive.html");
  expect(verifyStamp(readFileSync(archive, "utf8"))).toBe(true);
  const opened = await openOffline(browser, archive);
  expect(opened.blocked).toEqual([]);
  expect(opened.violations).toEqual([]);
});

test("re-saving a URL adds version 2 and keeps version 1", async () => {
  test.setTimeout(120_000);
  const lib = test.info().outputPath("library");
  const url = fixtureUrl("news-article");
  const first = await ok(lib, "save", url, "--no-mhtml", "--no-shot");
  expect(first).toMatch(/^saved [0-9a-z]{12} \(version 1 of 1\) /);
  const [v1] = json<PageRecord[]>(await ok(lib, "list", "--json"));
  const v1Archive = readFileSync(join(lib, v1!.dir, "archive.html"), "utf8");

  const second = await ok(lib, "save", url, "--no-mhtml", "--no-shot");
  expect(second).toMatch(/^saved [0-9a-z]{12} \(version 2 of 2\) /);
  const all = json<PageRecord[]>(await ok(lib, "list", "--json", "--all"));
  expect(all.map((p) => p.version)).toEqual([2, 1]);
  const [v2, again] = all;
  expect(again!.id).toBe(v1!.id);
  expect(v2!.id).not.toBe(v1!.id);
  expect(v2!.dir).not.toBe(v1!.dir);
  expect(v2!.versionOf).toBe(v1!.id);
  const v2Meta = json<PageMeta>(readFileSync(join(lib, v2!.dir, "meta.json"), "utf8"));
  expect(v2Meta.versionOf).toBe(v1!.id);
  // version 1 is kept as it was
  expect(readFileSync(join(lib, v1!.dir, "archive.html"), "utf8")).toBe(v1Archive);

  // the newest version is what list and search show; --all shows both
  expect(json<PageRecord[]>(await ok(lib, "list", "--json")).map((p) => p.id)).toEqual([v2!.id]);
  expect(json<SearchHit[]>(await ok(lib, "search", "gallery", "--json")).map((h) => h.id)).toEqual([v2!.id]);
  expect(json<SearchHit[]>(await ok(lib, "search", "gallery", "--json", "--all")).map((h) => h.id).sort()).toEqual([v1!.id, v2!.id].sort());

  // and the versions survive a rebuilt index
  rmSync(join(lib, "library.db"));
  await ok(lib, "reindex");
  expect(await ok(lib, "list", "--json", "--all")).toBe(JSON.stringify(all, null, 2) + "\n");

  // tags go into meta.json; open prints the archive or the reader copy
  expect(await ok(lib, "tag", v2!.id.slice(0, 6), "harbour", "tides")).toBe(`${v2!.id}  harbour, tides\n`);
  expect(json<PageMeta>(readFileSync(join(lib, v2!.dir, "meta.json"), "utf8")).tags).toEqual(["harbour", "tides"]);
  expect(json<PageRecord[]>(await ok(lib, "list", "--json", "--tag", "harbour")).map((p) => p.id)).toEqual([v2!.id]);
  expect(await ok(lib, "tag", v2!.id, "--remove", "tides")).toBe(`${v2!.id}  harbour\n`);
  expect(await ok(lib, "open", v2!.id, "--print")).toBe(`${join(lib, v2!.dir, "archive.html")}\n`);
  expect(await ok(lib, "open", v2!.id, "--reader", "--print")).toBe(`${join(lib, v2!.dir, "reader.html")}\n`);
  expect(await pa(lib, "open", "zzzzzzzz", "--print")).toMatchObject({ code: 2, stderr: "pa: no page with id zzzzzzzz\n" });
});

test("four `pa save` of one URL at once give versions 1 to 4, each saved once", async () => {
  // Each save's index write waits for the others' (BEGIN IMMEDIATE, then the busy timeout). A
  // deferred write fails here about one run in five with `saved to <dir>, but not indexed
  // (database is locked)`: SQLite will not wait to turn a read into a write while another process
  // holds the write lock. One run saw that failure with the write already immediate; its cause is
  // not known (Review.md, row 55). The library's unit test "makes an index write wait out a write
  // lock" fails every time against a deferred write.
  test.setTimeout(120_000);
  const lib = test.info().outputPath("library");
  const url = fixtureUrl("plain-article");
  const runs = await Promise.all(Array.from({ length: 4 }, () => pa(lib, "save", url, "--no-mhtml", "--no-shot")));
  for (const r of runs) {
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr, "no database-busy error").toBe("");
  }
  const all = json<PageRecord[]>(await ok(lib, "list", "--json", "--all"));
  expect(all.map((p) => p.version)).toEqual([4, 3, 2, 1]);
  expect(new Set(all.map((p) => p.id)).size).toBe(4);
  // each run printed its own saved page (the four outputs name the four ids)
  expect(runs.map((r) => /^saved ([0-9a-z]{12}) /.exec(r.stdout)?.[1]).sort()).toEqual(all.map((p) => p.id).sort());
  // the folders on disk agree: a rebuilt index lists the same pages
  const before = await ok(lib, "list", "--json", "--all");
  rmSync(join(lib, "library.db"));
  await ok(lib, "reindex");
  expect(await ok(lib, "list", "--json", "--all")).toBe(before);
});
