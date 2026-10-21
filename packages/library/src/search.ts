// Searching and listing the index. A query is words (all must match, a trailing * matches a
// prefix, "quoted words" match as a phrase, OR between two words matches either); --raw passes
// FTS5's own syntax through. Results carry a snippet of the matching text with the hits marked,
// and can be narrowed by site, tag and capture date. Only each page's newest version is shown
// unless every version is asked for.
import type Database from "better-sqlite3";

export interface Filters {
  /** The site's name (og:site_name) or the URL's host, either matched without regard to case. */
  site?: string | undefined;
  /** Pages carrying every one of these tags. */
  tags?: readonly string[] | undefined;
  /** Captured on or after this day (YYYY-MM-DD, UTC). */
  since?: string | undefined;
  /** Captured on or before this day (YYYY-MM-DD, UTC). */
  until?: string | undefined;
  /** Every version of each page, not only the newest. */
  allVersions?: boolean | undefined;
  limit?: number | undefined;
}

export interface SearchOptions extends Filters {
  /** The query is FTS5 syntax, passed through as it is. */
  raw?: boolean | undefined;
  /** What the snippet puts around each hit. Default [ and ]. */
  mark?: { open: string; close: string } | undefined;
  /** Words around the hits in the snippet. Default 16. */
  snippetWords?: number | undefined;
}

export interface PageRecord {
  id: string;
  /** The capture's folder, relative to the library root. */
  dir: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  byline: string | null;
  site: string | null;
  excerpt: string | null;
  lang: string | null;
  capturedAt: string;
  versionOf: string | null;
  /** This capture's number among its URL's captures, 1 for the first. */
  version: number;
  /** How many captures of its URL the library holds. */
  versions: number;
  tags: string[];
  bytes: number;
  hasReader: boolean;
}

export interface SearchHit extends PageRecord {
  snippet: string;
  /** bm25: lower is better. */
  score: number;
}

export class QueryError extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Words of a query made into an FTS5 expression that cannot be a syntax error. */
export function toFtsQuery(query: string): string {
  const parts: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (m[1] !== undefined) {
      if (/[\p{L}\p{N}]/u.test(m[1])) parts.push(`"${m[1].replace(/"/g, '""')}"`);
      continue;
    }
    const word = m[2]!;
    if (word === "OR" || word === "AND" || word === "NOT") {
      parts.push(word);
      continue;
    }
    const prefix = word.endsWith("*");
    const bare = prefix ? word.replace(/\*+$/, "") : word;
    if (!/[\p{L}\p{N}]/u.test(bare)) continue;
    parts.push(`"${bare.replace(/"/g, '""')}"${prefix ? "*" : ""}`);
  }
  // an operator needs a term on each side: a stray OR or AND is dropped, but a NOT dropped would
  // search for exactly what it was meant to exclude, so it is refused
  const operator = (p: string | undefined) => p !== undefined && /^(OR|AND|NOT)$/.test(p);
  const strayNot = parts.some((p, i) => p === "NOT" && (!parts.slice(0, i).some((q) => !operator(q)) || operator(parts[i + 1]) || i === parts.length - 1));
  if (strayNot) throw new QueryError(`NOT needs a word on each side: ${query}`);
  while (parts.length && operator(parts[0])) parts.shift();
  while (parts.length && operator(parts[parts.length - 1])) parts.pop();
  const out = parts.filter((p, i) => !(operator(p) && operator(parts[i + 1])));
  if (!out.length) throw new QueryError(`nothing to search for in: ${query}`);
  return out.join(" ");
}

function where(filters: Filters, alias: string): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (!filters.allVersions) sql.push(`${alias}.version = ${alias}.versions`);
  if (filters.site) {
    sql.push(`(lower(${alias}.site) = lower(?) OR ${alias}.host = lower(?))`);
    params.push(filters.site, filters.site);
  }
  for (const tag of filters.tags ?? []) {
    sql.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE json_each.value = ?)`);
    params.push(tag);
  }
  for (const [key, op] of [["since", ">="], ["until", "<="]] as const) {
    const day = filters[key];
    if (day === undefined) continue;
    if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new QueryError(`--${key} takes a day as YYYY-MM-DD: ${day}`);
    sql.push(`substr(${alias}.captured_at, 1, 10) ${op} ?`);
    params.push(day);
  }
  return { sql, params };
}

const COLUMNS = `v.id, v.dir, v.url, v.canonical_url AS canonicalUrl, v.title, v.byline, v.site, v.excerpt, v.lang,
  v.captured_at AS capturedAt, v.version_of AS versionOf, v.version, v.versions, v.tags, v.bytes, v.has_reader AS hasReader`;

type Row = Omit<PageRecord, "tags" | "hasReader"> & { tags: string; hasReader: number };

function toRecord<T extends Row>(row: T): Omit<T, "tags" | "hasReader"> & { tags: string[]; hasReader: boolean } {
  return { ...row, tags: JSON.parse(row.tags) as string[], hasReader: row.hasReader === 1 };
}

function limitOf(filters: Filters): number {
  const n = filters.limit ?? -1;
  if (!Number.isInteger(n)) throw new QueryError(`--limit takes a whole number: ${n}`);
  return n;
}

/** The library's pages, newest capture first. */
export function listPages(db: Database.Database, filters: Filters = {}): PageRecord[] {
  const w = where(filters, "v");
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM page_versions v ${w.sql.length ? `WHERE ${w.sql.join(" AND ")}` : ""} ORDER BY v.captured_at DESC, v.id DESC LIMIT ?`)
    .all(...w.params, limitOf(filters)) as Row[];
  return rows.map(toRecord);
}

/** The pages matching query, best match first. */
export function searchPages(db: Database.Database, query: string, opts: SearchOptions = {}): SearchHit[] {
  const match = opts.raw ? query : toFtsQuery(query);
  const mark = opts.mark ?? { open: "[", close: "]" };
  const words = Math.min(64, Math.max(1, opts.snippetWords ?? 16));
  const w = where(opts, "v");
  const sql = `
    SELECT ${COLUMNS},
           snippet(pages_fts, -1, ?, ?, '…', ${words}) AS snippet,
           bm25(pages_fts, 10.0, 2.0, 2.0, 1.0) AS score
    FROM pages_fts JOIN page_versions v ON v.rowid = pages_fts.rowid
    WHERE pages_fts MATCH ? ${w.sql.map((s) => `AND ${s}`).join(" ")}
    ORDER BY score, v.captured_at DESC, v.id
    LIMIT ?`;
  let rows: Array<Row & { snippet: string; score: number }>;
  try {
    rows = db.prepare(sql).all(mark.open, mark.close, match, ...w.params, limitOf(opts)) as typeof rows;
  } catch (err) {
    // the query is the only user input in the statement: with --raw, any SQL error it raises (a
    // syntax error, an unterminated string, "unknown special query") is the query's; a busy or
    // corrupt database is not
    if (opts.raw && (err as { code?: string }).code === "SQLITE_ERROR") throw new QueryError(`not an FTS5 query: ${query} (${(err as Error).message})`);
    throw err;
  }
  return rows.map(toRecord);
}

/** The page with this id, or with this unique id prefix (4 characters or more). */
export function findPage(db: Database.Database, idOrPrefix: string): PageRecord {
  const key = idOrPrefix.trim().toLowerCase();
  if (!/^[0-9a-z]{4,12}$/.test(key)) throw new QueryError(`not a page id: ${idOrPrefix}`);
  const rows = db.prepare(`SELECT ${COLUMNS} FROM page_versions v WHERE v.id >= ? AND v.id < ? ORDER BY v.id LIMIT 2`).all(key, `${key}{`) as Row[];
  const exact = rows.find((r) => r.id === key);
  if (exact) return toRecord(exact);
  if (rows.length === 0) throw new QueryError(`no page with id ${idOrPrefix}`);
  if (rows.length > 1) throw new QueryError(`more than one page id starts with ${idOrPrefix}`);
  return toRecord(rows[0]!);
}

export interface Facet {
  name: string;
  count: number;
}

export interface Facets {
  sites: Facet[];
  tags: Facet[];
}

/** The sites (og:site_name, else the host) and tags of each page's newest version, most used first. */
export function listFacets(db: Database.Database): Facets {
  const sites = db
    .prepare(
      `SELECT coalesce(nullif(v.site, ''), v.host) AS name, COUNT(*) AS count FROM page_versions v
       WHERE v.version = v.versions AND coalesce(nullif(v.site, ''), v.host) IS NOT NULL
       GROUP BY name ORDER BY count DESC, lower(name), name`,
    )
    .all() as Facet[];
  const tags = db
    .prepare(
      `SELECT t.value AS name, COUNT(*) AS count FROM page_versions v, json_each(v.tags) t
       WHERE v.version = v.versions GROUP BY t.value ORDER BY count DESC, lower(name), name`,
    )
    .all() as Facet[];
  return { sites, tags };
}
