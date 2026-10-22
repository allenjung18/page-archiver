import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARCHIVE_FILE, importHtml, META_FILE, type CaptureOptions, type PageMeta } from "@page-archiver/core";
import Database from "better-sqlite3";
import { DB_FILE } from "./layout.ts";
import { AlreadySavedError, openLibrary, type Library } from "./library.ts";
import { QueryError, toFtsQuery } from "./search.ts";

/** A SingleFile-style save of a short article. */
function save(opts: { url: string; title: string; site?: string; body: string; savedAt: string }): string {
  const site = opts.site ? `<meta property="og:site_name" content="${opts.site}">` : "";
  const paragraphs = [opts.body, "The rest of the article is ordinary prose about the weather, the tides and the harbour, long enough that a reader view finds it worth keeping as the main text."]
    .map((p) => `<p>${p}</p>`)
    .join("\n");
  return `<!DOCTYPE html><html lang="en"><!--
 Page saved with SingleFile
 url: ${opts.url}
 saved date: ${opts.savedAt}
--><head><meta charset="utf-8"><title>${opts.title}</title>${site}</head>
<body><nav>Home · About</nav><article><h1>${opts.title}</h1>${paragraphs}</article></body></html>`;
}

let tmp: string;
let lib: Library;

function file(name: string, html: string): string {
  const p = join(tmp, name);
  writeFileSync(p, html);
  return p;
}

const ARTICLES = [
  { url: "https://gazette.example/tides", title: "Tides of the Inner Basin", site: "The Harbour Gazette", body: "The basin floods twice a day and the quayside cafés move their chairs.", savedAt: "2026-03-12T10:00:00Z" },
  { url: "https://blog.example/kelp", title: "Kelp in Winter", body: "Holdfasts grip the rock; the zanzibarite shelf is where the urchins gather.", savedAt: "2026-05-01T08:30:00Z" },
  { url: "https://notes.example/bells", title: "The Fog Bell", body: "No ships. Fog. I rang the bell all night, said the keeper's ledger.", savedAt: "2026-07-20T22:15:00Z" },
];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "pa-library-"));
  lib = openLibrary(join(tmp, "lib"));
  for (const [i, a] of ARTICLES.entries()) await lib.importFile(file(`a${i}.html`, save(a)), { tags: i === 0 ? ["sea", "news"] : ["sea"] });
});

afterEach(() => {
  lib.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the library folder", () => {
  it("writes each capture to YYYY/MM/<slug>-<id>/ with meta.json and the archive", () => {
    const pages = lib.list();
    expect(pages.map((p) => p.dir)).toEqual([
      expect.stringMatching(/^2026\/07\/the-fog-bell-[0-9a-z]{12}$/),
      expect.stringMatching(/^2026\/05\/kelp-in-winter-[0-9a-z]{12}$/),
      expect.stringMatching(/^2026\/03\/tides-of-the-inner-basin-[0-9a-z]{12}$/),
    ]);
    for (const p of pages) {
      expect(p.dir.endsWith(p.id)).toBe(true);
      expect(existsSync(lib.pathOf(p))).toBe(true);
      const meta = JSON.parse(readFileSync(lib.pathOf(p, META_FILE), "utf8")) as PageMeta;
      expect(meta.id).toBe(p.id);
    }
  });
});

describe("search", () => {
  it("finds a word that appears in only one article, with the hit marked", () => {
    const hits = lib.search("zanzibarite");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: "Kelp in Winter", url: "https://blog.example/kelp", version: 1, versions: 1 });
    expect(hits[0]!.snippet).toContain("[zanzibarite]");
    // not in the page furniture: the nav is not the article
    expect(lib.search("Home")).toHaveLength(0);
  });

  it("matches words, prefixes, phrases, either-or, titles and sites", () => {
    expect(lib.search("fog bell").map((h) => h.title)).toEqual(["The Fog Bell"]);
    expect(lib.search("zanzib*").map((h) => h.title)).toEqual(["Kelp in Winter"]);
    expect(lib.search('"rang the bell"').map((h) => h.title)).toEqual(["The Fog Bell"]);
    expect(lib.search('"bell rang"')).toHaveLength(0);
    expect(lib.search("urchins OR quayside").map((h) => h.title).sort()).toEqual(["Kelp in Winter", "Tides of the Inner Basin"]);
    expect(lib.search("Gazette").map((h) => h.title)).toEqual(["Tides of the Inner Basin"]);
    expect(lib.search("cafes").map((h) => h.title)).toEqual(["Tides of the Inner Basin"]); // diacritics folded
    // a word in the title ranks that page first
    expect(lib.search("tides")[0]!.title).toBe("Tides of the Inner Basin");
  });

  it("never turns punctuation into an FTS5 syntax error", () => {
    for (const q of ["keeper's", "C++", 'a "b', "(", "OR", "-", "a AND", "*"]) {
      try {
        lib.search(q);
      } catch (err) {
        expect(err, q).toBeInstanceOf(QueryError);
      }
    }
    expect(lib.search("keeper's").map((h) => h.title)).toEqual(["The Fog Bell"]);
    expect(() => lib.search("NEAR(", { raw: true })).toThrow(QueryError);
  });

  it("refuses a NOT with no word before or after it, rather than search for what it would exclude", () => {
    for (const q of ["NOT zanzibarite", "zanzibarite NOT", "kelp NOT OR zanzibarite"]) {
      expect(() => toFtsQuery(q), q).toThrow(QueryError);
      expect(() => lib.search(q), q).toThrow(/^NOT needs a word on each side: /);
    }
    expect(lib.search("harbour NOT zanzibarite").map((h) => h.title).sort(), "NOT between two words still works").toEqual(["The Fog Bell", "Tides of the Inner Basin"]);
    // a leading or trailing OR or AND only widens or narrows nothing, and is still dropped
    expect(toFtsQuery("OR kelp AND")).toBe(`"kelp"`);
  });

  it("makes every malformed --raw query a query error, not an operational failure", () => {
    for (const q of ['"abc', "*", "NEAR(a b, x)", "NEAR(", "title:", "a AND"]) {
      expect(() => lib.search(q, { raw: true }), q).toThrow(QueryError);
    }
  });

  it("filters by site, tag and date", () => {
    expect(lib.search("the", { site: "the harbour gazette" }).map((h) => h.title)).toEqual(["Tides of the Inner Basin"]);
    expect(lib.search("the", { site: "BLOG.example" }).map((h) => h.title)).toEqual(["Kelp in Winter"]);
    expect(lib.search("the", { tags: ["news"] }).map((h) => h.title)).toEqual(["Tides of the Inner Basin"]);
    expect(lib.search("the", { tags: ["sea", "news"] })).toHaveLength(1);
    expect(lib.search("the", { tags: ["sea"] })).toHaveLength(3);
    expect(lib.list({ since: "2026-05-01" }).map((p) => p.title)).toEqual(["The Fog Bell", "Kelp in Winter"]);
    expect(lib.list({ until: "2026-05-01" }).map((p) => p.title)).toEqual(["Kelp in Winter", "Tides of the Inner Basin"]);
    expect(lib.list({ since: "2026-04-01", until: "2026-06-30" }).map((p) => p.title)).toEqual(["Kelp in Winter"]);
    expect(lib.list({ limit: 1 })).toHaveLength(1);
    expect(() => lib.list({ since: "May 2026" })).toThrow(QueryError);
  });
});

describe("reindex", () => {
  it("rebuilds the same index from the folders after library.db is deleted", async () => {
    const queries = ["zanzibarite", "the", "bell OR tides", "sea"];
    const before = { list: lib.list({ allVersions: true }), hits: queries.map((q) => lib.search(q)) };
    lib.close();
    rmSync(join(lib.root, DB_FILE));
    // `pa reindex` on a library whose index is gone
    lib = openLibrary(lib.root);
    expect(lib.reindex()).toEqual({ indexed: 3, skipped: [] });
    expect({ list: lib.list({ allVersions: true }), hits: queries.map((q) => lib.search(q)) }).toEqual(before);
    expect(before.hits[0]).toHaveLength(1);
  });

  it("builds a missing index on open", () => {
    const pages = lib.list();
    lib.close();
    rmSync(join(lib.root, DB_FILE));
    lib = openLibrary(lib.root);
    expect(existsSync(join(lib.root, DB_FILE))).toBe(true);
    expect(lib.list()).toEqual(pages);
  });

  it("keeps a page whose saved date is past the year 9999, filed under the file's own time", async () => {
    const far = file("far.html", save({ url: "https://far.example/p", title: "Far Future", body: "A vellichor ledger.", savedAt: "Sat Jan 01 10000 00:00:00 GMT+0000" }));
    const page = await lib.importFile(far);
    lib.reindex();
    expect(lib.list(), "pages after a reindex").toHaveLength(4);
    expect(page.dir).toMatch(/^\d{4}\/\d{2}\//);
    expect(lib.search("vellichor").map((p) => p.id)).toEqual([page.id]);
  });

  it("passes over unfinished and broken folders, and says which", () => {
    // a capture that died before meta.json, and one whose meta.json is not JSON
    mkdirSync(join(lib.root, "2026/08/half-done-aaaaaaaaaaaa"), { recursive: true });
    writeFileSync(join(lib.root, "2026/08/half-done-aaaaaaaaaaaa", ARCHIVE_FILE), "<p>x");
    mkdirSync(join(lib.root, "2026/08/broken-bbbbbbbbbbbb"), { recursive: true });
    writeFileSync(join(lib.root, "2026/08/broken-bbbbbbbbbbbb", META_FILE), "{ not json");
    const report = lib.reindex();
    expect(report.indexed).toBe(3);
    expect(report.skipped.map((s) => s.dir)).toEqual(["2026/08/broken-bbbbbbbbbbbb", "2026/08/half-done-aaaaaaaaaaaa"]);
    expect(report.skipped[1]!.reason).toMatch(/no meta\.json/);
  });
});

describe("versions", () => {
  it("re-saving a URL adds version 2 and keeps version 1", async () => {
    const v1 = lib.search("zanzibarite")[0]!;
    const v1Archive = readFileSync(lib.pathOf(v1), "utf8");
    const again = { ...ARTICLES[1]!, body: "Holdfasts grip the rock; the zanzibarite shelf is quieter this year.", savedAt: "2026-09-02T09:00:00Z" };
    const v2 = await lib.importFile(file("again.html", save(again)));
    expect(v2.dir).toMatch(/^2026\/09\/kelp-in-winter-/);
    expect(v2).toMatchObject({ version: 2, versions: 2, versionOf: v1.id, url: v1.url });
    expect(v2.dir).not.toBe(v1.dir);
    // version 1 is still on disk, unchanged, and still indexed
    expect(readFileSync(lib.pathOf(v1), "utf8")).toBe(v1Archive);
    expect(lib.get(v1.id)).toMatchObject({ version: 1, versions: 2 });
    expect(lib.versions(v1.url).map((v) => [v.id, v.version])).toEqual([[v1.id, 1], [v2.id, 2]]);
    // list and search show the newest version; --all shows both
    expect(lib.list().filter((p) => p.url === v1.url).map((p) => p.id)).toEqual([v2.id]);
    expect(lib.list({ allVersions: true }).filter((p) => p.url === v1.url).map((p) => p.version)).toEqual([2, 1]);
    expect(lib.search("zanzibarite").map((h) => h.id)).toEqual([v2.id]);
    expect(lib.search("zanzibarite", { allVersions: true }).map((h) => h.id).sort()).toEqual([v1.id, v2.id].sort());
    // the numbering survives a rebuild
    lib.reindex();
    expect(lib.get(v2.id)).toMatchObject({ version: 2, versions: 2, versionOf: v1.id });
    // the same file imported twice is one capture, whatever it is called
    await expect(lib.importFile(join(tmp, "again.html"))).rejects.toThrow(`already in the library as ${v2.id}`);
    await expect(lib.importFile(file("renamed.html", save(again)))).rejects.toThrow(`already in the library as ${v2.id}`);
  });

  it("a re-import keeps the tags of the version before it", async () => {
    const v1 = lib.search("zanzibarite")[0]!;
    lib.tag(v1.id, ["kelp"]);
    const v2 = await lib.importFile(file("again.html", save({ ...ARTICLES[1]!, body: "The zanzibarite shelf again.", savedAt: "2026-09-02T09:00:00Z" })), { tags: ["winter"] });
    expect(v2.tags).toEqual([...v1.tags, "kelp", "winter"]);
    expect(lib.list({ tags: ["kelp"] }).map((p) => p.id)).toEqual([v2.id]);
  });

  it("a second, different save of a URL with the same saved time is still a version of the first", async () => {
    const first = lib.search("zanzibarite")[0]!;
    const twin = await lib.importFile(file("twin.html", save({ ...ARTICLES[1]!, body: "A different body about the zanzibarite shelf." })));
    expect(twin.capturedAt).toBe(first.capturedAt);
    expect(twin.versionOf).toBe(first.id);
    expect(twin.versions).toBe(2);
  });

  it("an older save of a URL slots in before the newer one", async () => {
    const older = { ...ARTICLES[2]!, savedAt: "2026-01-05T12:00:00Z", body: "An older entry about the bell." };
    const page = await lib.importFile(file("older.html", save(older)));
    expect(page).toMatchObject({ version: 1, versions: 2 });
    expect(page.versionOf).toBeNull();
  });
});

describe("save", () => {
  it("captures a URL the library holds as its next version", async () => {
    const seen: Array<CaptureOptions | undefined> = [];
    // a second handle on the same library, capturing with a stand-in for Chromium
    const saver = openLibrary(lib.root, {
      capture: async (url, opts) => {
        seen.push(opts);
        return importHtml(save({ ...ARTICLES[2]!, savedAt: "2026-10-01T00:00:00Z" }), { url, versionOf: opts?.versionOf, reader: opts?.extras?.reader, tags: opts?.tags });
      },
    });
    const v1 = lib.list({ allVersions: true }).find((p) => p.url === ARTICLES[2]!.url && p.version === 1)!;
    lib.tag(v1.id, ["bells"]);
    const { page } = await saver.save(ARTICLES[2]!.url, { extras: { mhtml: false }, tags: ["new"] });
    expect(seen[0]).toMatchObject({ versionOf: v1.id, extras: { reader: true, mhtml: false, png: true, pdf: true } });
    expect(page).toMatchObject({ version: 2, versions: 2, versionOf: v1.id });
    // the new version keeps version 1's tags, so a tag filter still finds the page
    expect(page.tags).toEqual(["sea", "bells", "new"]);
    expect(lib.list({ tags: ["bells"] }).map((p) => p.id)).toEqual([page.id]);
    // a URL the library does not hold is version 1 of 1
    const { page: fresh } = await saver.save("https://new.example/page");
    expect(fresh).toMatchObject({ version: 1, versions: 1, versionOf: null });
    expect(seen[1]?.versionOf).toBeUndefined();
    saver.close();
  });
});

describe("importHtml", () => {
  it("adds an archive page-archiver made elsewhere under its own URL and capture time, once", async () => {
    // what the Chrome extension posts: a stamped archive, here of a URL the library does not hold
    const page0 = save({ url: "https://moor.example/heather", title: "Heather on the Moor", body: "The heather turns purple in August.", savedAt: "2026-08-14T06:00:00Z" });
    // without the SingleFile header, so the only thing that says where it is from is our own stamp
    const made = importHtml(page0.replace(/<!--[\s\S]*?-->/, ""), { url: "https://moor.example/heather", savedAt: new Date("2026-08-14T06:00:00Z"), reader: false });
    const { archive, page } = await lib.importHtml(made.html, { tags: ["moor"], source: "the Chrome extension" });
    expect(page).toMatchObject({ url: "https://moor.example/heather", capturedAt: "2026-08-14T06:00:00.000Z", version: 1, versions: 1, tags: ["moor"] });
    // its own warnings carried through, and no second "imported" line for this import
    expect(archive.warnings).toEqual(made.meta.warnings);
    expect(readFileSync(lib.pathOf(page), "utf8")).toContain("The heather turns purple in August.");
    await expect(lib.importHtml(made.html)).rejects.toBeInstanceOf(AlreadySavedError);
    await expect(lib.importHtml(made.html)).rejects.toThrow(`already in the library as ${page.id}`);
  });

  it("a page the library holds becomes its next version, keeping the tags", async () => {
    const v1 = lib.search("zanzibarite")[0]!;
    const made = importHtml(save({ ...ARTICLES[1]!, body: "The zanzibarite shelf, behind a login.", savedAt: "2026-10-20T07:00:00Z" }), { reader: false });
    const { page } = await lib.importHtml(made.html, { url: v1.url, tags: ["login"] });
    expect(page).toMatchObject({ version: 2, versionOf: v1.id, tags: ["sea", "login"] });
  });
});

describe("the index file", () => {
  it("is rebuilt when it is not a database, or of another schema version", () => {
    const pages = lib.list();
    lib.close();
    writeFileSync(join(lib.root, DB_FILE), "this is not sqlite");
    lib = openLibrary(lib.root);
    expect(lib.list()).toEqual(pages);
    lib.db.pragma("user_version = 99");
    lib.db.exec("DELETE FROM pages");
    lib.close();
    lib = openLibrary(lib.root);
    expect(lib.list()).toEqual(pages);
  });

  it("can be rebuilt while another handle has it open", async () => {
    const other = openLibrary(lib.root);
    await lib.importFile(file("new.html", save({ url: "https://x.example/n", title: "Late Arrival", body: "A quorbleflint arrives.", savedAt: "2026-08-01T00:00:00Z" })));
    expect(other.reindex().indexed).toBe(4);
    expect(lib.search("quorbleflint")).toHaveLength(1);
    expect(other.search("quorbleflint")).toHaveLength(1);
    // the rebuilt index is a plain SQLite file another tool can read
    other.close();
    const raw = new Database(join(lib.root, DB_FILE), { readonly: true });
    expect(raw.prepare("SELECT count(*) AS n FROM pages").get()).toEqual({ n: 4 });
    raw.close();
  });
});

describe("another process holding the write lock", () => {
  /** A second connection inside BEGIN IMMEDIATE, as a `pa reindex` or `pa save` in another process is. */
  function holdWriteLock(): Database.Database {
    const other = new Database(join(lib.root, DB_FILE));
    other.exec("BEGIN IMMEDIATE");
    return other;
  }

  it("does not stop a read-only command from opening the library", () => {
    lib.close();
    const other = holdWriteLock();
    try {
      const root = lib.root;
      expect(() => (lib = openLibrary(root, { busyTimeoutMs: 200 })), "opening a current index for reading").not.toThrow();
      expect(lib.list()).toHaveLength(3);
      expect(lib.search("zanzibarite")).toHaveLength(1);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  }, 30_000);

  it("makes a save wait out a write lock another process holds, not fail at once", async () => {
    // The index write is BEGIN IMMEDIATE. A deferred one reads (SELECT rowid) before it writes,
    // and SQLite refuses the upgrade at once, without the busy timeout, while another process holds
    // the write lock: concurrent `pa save`s failed with "database is locked" that way.
    const driver = createRequire(import.meta.url).resolve("better-sqlite3");
    const holder = spawn(process.execPath, ["-e", `const D = require(${JSON.stringify(driver)}); const db = new D(process.argv[1]); db.exec("BEGIN IMMEDIATE"); console.log("held"); setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`, join(lib.root, DB_FILE)], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((done) => holder.on("exit", done));
    await new Promise<void>((held, failed) => {
      holder.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("held") && held());
      holder.on("exit", () => failed(new Error("the lock holder exited before it held the lock")));
    });
    try {
      const started = Date.now();
      const html = save({ url: "https://x.example/queued", title: "Queued", body: "A tarnwhistle waits its turn.", savedAt: "2026-08-03T00:00:00Z" });
      await expect(lib.importHtml(html), "a save while another process writes").resolves.toMatchObject({ page: { title: "Queued" } });
      expect(Date.now() - started, "waited for the other process's commit").toBeGreaterThanOrEqual(200);
    } finally {
      holder.kill();
      await exited;
    }
    expect(lib.search("tarnwhistle")).toHaveLength(1);
  }, 30_000);

  it("makes a save that cannot be indexed say where it was saved and how to index it", async () => {
    lib.close();
    lib = openLibrary(lib.root, { busyTimeoutMs: 200 });
    const other = holdWriteLock();
    try {
      const html = save({ url: "https://x.example/late", title: "Locked Out", body: "A plinthwort waits.", savedAt: "2026-08-02T00:00:00Z" });
      await expect(lib.importHtml(html)).rejects.toThrow(/^saved to 2026\/08\/locked-out-[0-9a-z]{12}, but not indexed \(database is locked\): pa reindex adds it$/);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(lib.reindex().indexed).toBe(4);
    expect(lib.search("plinthwort")).toHaveLength(1);
  }, 30_000);
});

describe("tags", () => {
  it("writes tags to meta.json, so they survive a rebuild", () => {
    const page = lib.search("zanzibarite")[0]!;
    expect(lib.tag(page.id.slice(0, 5), ["kelp", "to-read", "kelp"], ["sea"]).tags).toEqual(["kelp", "to-read"]);
    expect((JSON.parse(readFileSync(lib.pathOf(page, META_FILE), "utf8")) as PageMeta).tags).toEqual(["kelp", "to-read"]);
    lib.reindex();
    expect(lib.list({ tags: ["to-read"] }).map((p) => p.id)).toEqual([page.id]);
    expect(lib.tag(page.id, [], ["to-read"]).tags).toEqual(["kelp"]);
  });

  it("finds pages by unique id prefix and refuses an unknown or ambiguous one", () => {
    const [p] = lib.list();
    expect(lib.get(p!.id.slice(0, 6)).id).toBe(p!.id);
    expect(() => lib.get("zzzzzzzz")).toThrow(/no page/);
    expect(() => lib.get("ab")).toThrow(/not a page id/);
  });

  it("refuses a prefix two page ids share, and remove by it deletes nothing", () => {
    const base = lib.list()[0]!;
    const baseDir = lib.pathOf(base, "");
    const folders = ["abcd1111xxxx", "abcd2222xxxx"].map((id, i) => {
      const dir = join(lib.root, "2026/08", `twin-${id}`);
      mkdirSync(dir, { recursive: true });
      const meta = JSON.parse(readFileSync(join(baseDir, META_FILE), "utf8")) as PageMeta;
      writeFileSync(join(dir, META_FILE), JSON.stringify({ ...meta, id, url: `https://twins.example/${i}`, capturedAt: "2026-08-02T10:00:00Z" }));
      writeFileSync(join(dir, ARCHIVE_FILE), readFileSync(join(baseDir, ARCHIVE_FILE)));
      return dir;
    });
    lib.reindex();
    expect(lib.get("abcd1111xxxx").id).toBe("abcd1111xxxx");
    expect(() => lib.get("abcd")).toThrow(/more than one page id starts with abcd/);
    expect(() => lib.remove("abcd")).toThrow(/more than one page id starts with abcd/);
    for (const dir of folders) expect(existsSync(dir), dir).toBe(true);
  });
});

describe("remove", () => {
  it("deletes the capture's folder and its index rows, and a rebuild does not bring it back", () => {
    const page = lib.search("zanzibarite")[0]!;
    const folder = lib.pathOf(page, "");
    expect(lib.remove(page.id).id).toBe(page.id);
    expect(existsSync(folder)).toBe(false);
    expect(() => lib.get(page.id)).toThrow(/no page/);
    expect(() => lib.search("zanzibarite")).not.toThrow();
    expect(lib.search("zanzibarite")).toEqual([]);
    expect(lib.list()).toHaveLength(2);
    lib.reindex();
    expect(lib.list()).toHaveLength(2);
    expect(lib.search("zanzibarite")).toEqual([]);
    expect(() => lib.remove(page.id)).toThrow(/no page/);
  });

  it("a folder already gone from the disk still leaves the index", () => {
    const page = lib.search("zanzibarite")[0]!;
    rmSync(lib.pathOf(page, ""), { recursive: true });
    lib.remove(page.id);
    expect(() => lib.get(page.id)).toThrow(/no page/);
  });

  it("deleting version 1 keeps version 2 and renumbers it", async () => {
    const v1 = lib.search("zanzibarite")[0]!;
    const v2 = await lib.importFile(file("again.html", save({ ...ARTICLES[1]!, body: "The zanzibarite shelf again.", savedAt: "2026-09-02T09:00:00Z" })));
    lib.remove(v1.id);
    expect(lib.get(v2.id)).toMatchObject({ version: 1, versions: 1 });
    expect(lib.search("zanzibarite").map((h) => h.id)).toEqual([v2.id]);
  });
});

describe("facets", () => {
  it("counts the sites and tags of each page's newest version", async () => {
    expect(lib.facets()).toEqual({
      sites: [
        { name: "blog.example", count: 1 },
        { name: "notes.example", count: 1 },
        { name: "The Harbour Gazette", count: 1 },
      ],
      tags: [
        { name: "sea", count: 3 },
        { name: "news", count: 1 },
      ],
    });
    // a newer version replaces the older one in the counts
    await lib.importFile(file("again.html", save({ ...ARTICLES[1]!, body: "The zanzibarite shelf again.", savedAt: "2026-09-02T09:00:00Z" })), { tags: ["kelp"] });
    expect(lib.facets().tags).toEqual([
      { name: "sea", count: 3 },
      { name: "kelp", count: 1 },
      { name: "news", count: 1 },
    ]);
    // each facet name is a filter list() understands
    for (const s of lib.facets().sites) expect(lib.list({ site: s.name })).toHaveLength(s.count);
  });
});
