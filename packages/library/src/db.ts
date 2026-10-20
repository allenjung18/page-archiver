// library.db: a pages table and an FTS5 index over each capture's title, byline, site and text.
// It is an index, never the record: everything in it comes from the capture folders, and
// rebuildIndex() makes it again from them, in place and in one transaction, so a reader or a
// concurrent `pa save` sees either the old index or the new one, never a file swapped under it.
import { rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DB_FILE, scanLibrary, type FolderEntry, type Skipped } from "./layout.ts";
import { urlKey, VERSIONS_VIEW } from "./versions.ts";

/** Bumped when the schema changes; an index of another version is rebuilt. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  dir TEXT NOT NULL,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  host TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  byline TEXT,
  site TEXT,
  excerpt TEXT,
  lang TEXT,
  captured_at TEXT NOT NULL,
  version_of TEXT,
  tags TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER NOT NULL,
  has_reader INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_url_key ON pages (url_key, captured_at);
CREATE INDEX IF NOT EXISTS pages_captured_at ON pages (captured_at);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5 (
  title, byline, site, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
${VERSIONS_VIEW};
`;

/** The FTS5 columns, in order (snippet() and bm25() weights follow it). */
export const FTS_COLUMNS = ["title", "byline", "site", "text"] as const;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

const DROP = `
DROP VIEW IF EXISTS page_versions;
DROP TABLE IF EXISTS pages_fts;
DROP TABLE IF EXISTS pages;
`;

export interface RebuildReport {
  indexed: number;
  skipped: Skipped[];
}

function isUnreadable(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? "";
  return code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT");
}

/**
 * Opens the library's index (root/library.db), building it from the folders when it is new, of
 * another schema version, or not a readable database at all.
 */
export function openIndex(root: string): Database.Database {
  const path = join(root, DB_FILE);
  for (let attempt = 0; ; attempt++) {
    let db: Database.Database | undefined;
    try {
      db = new Database(path);
      db.pragma("busy_timeout = 10000");
      ensureIndex(db, root);
      return db;
    } catch (err) {
      db?.close();
      if (attempt > 0 || !isUnreadable(err)) throw err;
      // an index that is not a database is rebuilt from scratch: the folders are the record
      for (const p of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
    }
  }
}

/** Builds the index from the folders unless it is already at this schema version. Null when it was. */
export function ensureIndex(db: Database.Database, root: string): RebuildReport | null {
  return db
    .transaction(() => ((db.pragma("user_version", { simple: true }) as number) === SCHEMA_VERSION ? null : rebuild(db, root)))
    .immediate();
}

/** Rebuilds the index from the library's folders, in one transaction: a failure leaves it as it was. */
export function rebuildIndex(db: Database.Database, root: string): RebuildReport {
  return db.transaction(() => rebuild(db, root)).immediate();
}

function rebuild(db: Database.Database, root: string): RebuildReport {
  const { entries, skipped } = scanLibrary(root);
  db.exec(DROP);
  db.exec(SCHEMA);
  for (const e of entries) indexEntry(db, e);
  db.exec("INSERT INTO pages_fts (pages_fts) VALUES ('optimize')");
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return { indexed: entries.length, skipped };
}

/** Adds a capture to the index, replacing any row with its id. */
export function indexEntry(db: Database.Database, entry: FolderEntry): void {
  const m = entry.meta;
  const bytes = Object.values(m.bytes ?? {}).reduce((a: number, b) => a + (typeof b === "number" ? b : 0), 0);
  const write = db.transaction(() => {
    const old = db.prepare("SELECT rowid FROM pages WHERE id = ?").get(m.id) as { rowid: number } | undefined;
    if (old) {
      db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(old.rowid);
      db.prepare("DELETE FROM pages WHERE rowid = ?").run(old.rowid);
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO pages (id, dir, url, url_key, host, canonical_url, title, byline, site, excerpt, lang,
                            captured_at, version_of, tags, sha256, bytes, has_reader)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        entry.dir,
        m.url,
        urlKey(m.url),
        hostOf(m.url),
        m.canonicalUrl ?? null,
        m.title,
        m.byline ?? null,
        m.site ?? null,
        m.excerpt ?? null,
        m.lang ?? null,
        new Date(m.capturedAt).toISOString(),
        m.versionOf ?? null,
        JSON.stringify(m.tags ?? []),
        m.sha256 ?? null,
        bytes,
        entry.hasReader ? 1 : 0,
      );
    db.prepare("INSERT INTO pages_fts (rowid, title, byline, site, text) VALUES (?, ?, ?, ?, ?)").run(
      lastInsertRowid,
      m.title,
      m.byline ?? "",
      m.site ?? "",
      entry.text,
    );
  });
  // BEGIN IMMEDIATE: a deferred transaction that reads first and writes second gets SQLITE_BUSY at
  // once, without waiting, when another process is committing (`pa save`s running side by side)
  write.immediate();
}

/** Sets a page's tags in the index (its meta.json is the caller's to write first). */
export function setIndexedTags(db: Database.Database, id: string, tags: readonly string[]): void {
  db.transaction(() => db.prepare("UPDATE pages SET tags = ? WHERE id = ?").run(JSON.stringify(tags), id)).immediate();
}

/** Removes a page's rows from the index (its folder is the caller's to remove first). */
export function removeIndexed(db: Database.Database, id: string): void {
  db.transaction(() => {
    const row = db.prepare("SELECT rowid FROM pages WHERE id = ?").get(id) as { rowid: number } | undefined;
    if (!row) return;
    db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM pages WHERE rowid = ?").run(row.rowid);
  }).immediate();
}
