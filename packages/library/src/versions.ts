// Versions: capturing a URL the library already holds adds a new capture beside the old one,
// never over it. Captures of one URL (its fragment ignored) are that page's versions, numbered
// 1, 2, … in capture order; the newest is the page's current version. The numbers are derived
// from the captures' URLs and times every time they are read, so a rebuilt index numbers them the
// same way and deleting a version renumbers the rest without anything to fix up.
import type Database from "better-sqlite3";

/** The key captures of one page share: the URL with its fragment removed. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/**
 * The view every read goes through: each page row with its version number and its URL's
 * version count. Ties in capture time are broken by id, so the order is total.
 */
export const VERSIONS_VIEW = `
CREATE VIEW IF NOT EXISTS page_versions AS
  SELECT p.*,
         ROW_NUMBER() OVER (PARTITION BY p.url_key ORDER BY p.captured_at, p.id) AS version,
         COUNT(*) OVER (PARTITION BY p.url_key) AS versions
  FROM pages p`;

/** Later than any capture: previousVersion(db, url, LATEST) is the URL's newest capture. */
export const LATEST = "9999-12-31T23:59:59.999Z";

export interface VersionRef {
  id: string;
  capturedAt: string;
  version: number;
}

/** The newest capture of url taken at or before `at` (ISO time), or null: what a new capture taken then is a version of. */
export function previousVersion(db: Database.Database, url: string, at: string): VersionRef | null {
  const row = db
    .prepare(
      `SELECT id, captured_at AS capturedAt, version FROM page_versions
       WHERE url_key = ? AND captured_at <= ? ORDER BY captured_at DESC, id DESC LIMIT 1`,
    )
    .get(urlKey(url), at) as VersionRef | undefined;
  return row ?? null;
}

/** Every capture of url, oldest first. */
export function versionsOf(db: Database.Database, url: string): VersionRef[] {
  return db
    .prepare(`SELECT id, captured_at AS capturedAt, version FROM page_versions WHERE url_key = ? ORDER BY version`)
    .all(urlKey(url)) as VersionRef[];
}
