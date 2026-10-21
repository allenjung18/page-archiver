// library.db: a pages table and an FTS5 index over each capture's title, byline, site and text.
// It is an index, never the record: everything in it comes from the capture folders, and
// rebuildIndex() makes it again from them, in place and in one transaction, so a reader or a
// concurrent `pa save` sees either the old index or the new one, never a file swapped under it.
// The folders are read before that transaction takes the write lock, so a long scan holds up no
// other writer; opening an index that is already current takes no write lock at all.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { META_FILE } from "@page-archiver/core";
import Database from "better-sqlite3";
import { DB_FILE, readCaptureFolder, scanLibrary, type FolderEntry, type Skipped } from "./layout.ts";
import { urlKey, VERSIONS_VIEW } from "./versions.ts";

/** How long a write waits for another process's write lock before it fails. */
export const BUSY_TIMEOUT_MS = 10_000;

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
export function openIndex(root: string, busyTimeoutMs: number = BUSY_TIMEOUT_MS): Database.Database {
  const path = join(root, DB_FILE);
  for (let attempt = 0; ; attempt++) {
    let db: Database.Database | undefined;
    try {
      db = new Database(path);
      db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
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

const isCurrent = (db: Database.Database) => (db.pragma("user_version", { simple: true }) as number) === SCHEMA_VERSION;

/**
 * Builds the index from the folders unless it is already at this schema version. Null when it was.
 * A current index is read with no lock (a read-only command never waits for a writer); otherwise
 * the folders are scanned, and the write lock is taken (and the version checked again: another
 * process may have built it meanwhile) only to write the index.
 */
export function ensureIndex(db: Database.Database, root: string): RebuildReport | null {
  if (isCurrent(db)) return null;
  const scan = scanLibrary(root);
  return db.transaction(() => (isCurrent(db) ? null : rebuild(db, root, scan))).immediate();
}

/** Rebuilds the index from the library's folders, in one transaction: a failure leaves it as it was. */
export function rebuildIndex(db: Database.Database, root: string): RebuildReport {
  const scan = scanLibrary(root);
  return db.transaction(() => rebuild(db, root, scan)).immediate();
}

/**
 * Writes the index from a scan taken before the write lock. Between the two another process may
 * have added a page (its row is in the index, its folder was not in the scan: kept) or removed one
 * (its folder is gone: dropped), so the folders are checked again, by a stat each.
 */
function rebuild(db: Database.Database, root: string, scan: { entries: FolderEntry[]; skipped: Skipped[] }): RebuildReport {
  const has = (dir: string) => existsSync(join(root, dir, META_FILE));
  const entries = scan.entries.filter((e) => has(e.dir));
  const scanned = new Set(entries.map((e) => e.meta.id));
  const hasPages = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pages'").get() !== undefined;
  const rows = hasPages ? (db.prepare("SELECT id, dir FROM pages").all() as Array<{ id: string; dir: string }>) : [];
  for (const row of rows) {
    if (scanned.has(row.id) || !has(row.dir)) continue;
    try {
      entries.push(readCaptureFolder(root, row.dir));
    } catch {
      // a folder that cannot be read now is the next reindex's to report
    }
  }
  db.exec(DROP);
  db.exec(SCHEMA);
  for (const e of entries) indexEntry(db, e);
  db.exec("INSERT INTO pages_fts (pages_fts) VALUES ('optimize')");
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return { indexed: entries.length, skipped: scan.skipped };
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
