// One library: its root folder and its index, opened together. Adding a capture writes its
// folder first (meta.json last) and indexes it second, so the folder is always the record. An
// index that is missing is built from the folders on open.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ARCHIVE_FILE,
  capture,
  importHtml,
  META_FILE,
  normalizeTags,
  readSavedHeader,
  serializeMeta,
  writeCapture,
  type Archive,
  type CaptureOptions,
  type PageMeta,
} from "@page-archiver/core";
import type Database from "better-sqlite3";
import { indexEntry, openIndex, rebuildIndex, removeIndexed, setIndexedTags, type RebuildReport } from "./db.ts";
import { captureFolder, readCaptureFolder } from "./layout.ts";
import { findPage, listFacets, listPages, searchPages, type Facets, type Filters, type PageRecord, type SearchHit, type SearchOptions } from "./search.ts";
import { LATEST, previousVersion, urlKey, versionsOf, type VersionRef } from "./versions.ts";

export type SaveOptions = Omit<CaptureOptions, "outDir" | "outFile" | "versionOf">;

export interface ImportFileOptions {
  /** The page's URL, when the file does not name it (or to override what it names). */
  url?: string | undefined;
  tags?: readonly string[] | undefined;
}

export interface ImportHtmlOptions extends ImportFileOptions {
  /** When it was saved, if the HTML does not say. Default: now. */
  savedAt?: Date | undefined;
  /** Where the HTML came from, for the import warning (e.g. a file name). */
  source?: string | undefined;
}

/** The same bytes of the same URL are in the library already. */
export class AlreadySavedError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`already in the library as ${id}`);
    this.id = id;
  }
}

export interface LibraryOptions {
  /** What save() captures with (tests); default core's capture(). */
  capture?: typeof capture | undefined;
  /** How long a write waits for another process's write lock. Default BUSY_TIMEOUT_MS (10 s). */
  busyTimeoutMs?: number | undefined;
}

export interface Library {
  readonly root: string;
  readonly db: Database.Database;
  /**
   * Writes a capture's folder and indexes it; returns its record. The capture's meta.versionOf is
   * the caller's: save() and importFile() set it to the URL's previous version.
   */
  add(archive: Archive): Promise<PageRecord>;
  /** Captures url into the library: a new version when the library holds the URL already. */
  save(url: string, opts?: SaveOptions): Promise<{ archive: Archive; page: PageRecord }>;
  /** Imports a saved HTML file (a SingleFile save), as a new version when the URL is known. */
  importFile(file: string, opts?: ImportFileOptions): Promise<PageRecord>;
  /**
   * Imports saved HTML from memory: a SingleFile save, or an archive page-archiver made elsewhere
   * (the Chrome extension's), which keeps its own stamp's URL, time and warnings. Sanitized again
   * whatever it claims to be.
   */
  importHtml(html: string, opts?: ImportHtmlOptions): Promise<{ archive: Archive; page: PageRecord }>;
  list(filters?: Filters): PageRecord[];
  search(query: string, opts?: SearchOptions): SearchHit[];
  /** The page with this id or unique id prefix. */
  get(idOrPrefix: string): PageRecord;
  /** Every capture of url, oldest first. */
  versions(url: string): VersionRef[];
  /** The sites and tags of the pages list() shows, each with how many pages carry it. */
  facets(): Facets;
  /**
   * Deletes one capture: its folder first (moved out of the library in one rename, then
   * removed), then its index rows. The URL's other versions stay and are renumbered.
   */
  remove(idOrPrefix: string): PageRecord;
  /** Adds and removes tags: meta.json first, then the index. */
  tag(idOrPrefix: string, add: readonly string[], remove?: readonly string[]): PageRecord;
  /** A file in a page's folder, as an absolute path (archive.html unless named). */
  pathOf(page: PageRecord, file?: string): string;
  /** Rebuilds the index from the folders, in place. */
  reindex(): RebuildReport;
  close(): void;
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, path);
}

/**
 * Opens the library at root, making the folder when it does not exist. A missing (or outdated,
 * or unreadable) library.db is built from the folders before anything is read.
 */
export function openLibrary(root: string, options: LibraryOptions = {}): Library {
  mkdirSync(root, { recursive: true });
  if (!statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const db = openIndex(root, options.busyTimeoutMs);

  async function add(archive: Archive): Promise<PageRecord> {
    const dir = captureFolder(archive.meta);
    const abs = join(root, dir);
    if (existsSync(abs)) throw new Error(`${dir} already exists in the library`);
    archive.files = await writeCapture(abs, archive);
    archive.file = archive.files.archive;
    try {
      indexEntry(db, readCaptureFolder(root, dir));
    } catch (err) {
      // the capture is on disk and complete; only the index (rebuilt from the folders) lacks it
      throw new Error(`saved to ${dir}, but not indexed (${(err as Error).message.split("\n")[0]}): pa reindex adds it`, { cause: err });
    }
    return findPage(db, archive.meta.id);
  }

  async function importText(html: string, opts: ImportHtmlOptions = {}): Promise<{ archive: Archive; page: PageRecord }> {
    const header = readSavedHeader(html);
    const url = opts.url ?? header?.url ?? undefined;
    const savedAt = header?.savedAt ?? opts.savedAt ?? new Date();
    const prev = url ? previousVersion(db, url, savedAt.toISOString()) : null;
    // a new version keeps the tags of the one before it, so `--tag` still finds the page
    const tags = [...(prev ? findPage(db, prev.id).tags : []), ...(opts.tags ?? [])];
    const archive = importHtml(html, { url, savedAt, tags, source: opts.source, ...(prev ? { versionOf: prev.id } : {}) });
    // the same file imported again stamps to the same bytes: it is already here
    const same = db.prepare("SELECT id FROM pages WHERE url_key = ? AND sha256 = ?").get(urlKey(archive.meta.url), archive.sha256) as { id: string } | undefined;
    if (same) throw new AlreadySavedError(same.id);
    return { archive, page: await add(archive) };
  }

  return {
    root,
    db,
    add,
    async save(url, opts = {}) {
      // every capture already in the library was taken before this one
      const prev = previousVersion(db, url, LATEST);
      const extras = { reader: true, mhtml: true, png: true, pdf: true, ...opts.extras };
      const tags = [...(prev ? findPage(db, prev.id).tags : []), ...(opts.tags ?? [])];
      const archive = await (options.capture ?? capture)(url, { ...opts, extras, tags, ...(prev ? { versionOf: prev.id } : {}) });
      return { archive, page: await add(archive) };
    },
    async importFile(file, opts = {}) {
      const html = readFileSync(file, "utf8");
      return (await importText(html, { ...opts, savedAt: statSync(file).mtime, source: basename(file) })).page;
    },
    importHtml: importText,
    list: (filters) => listPages(db, filters),
    search: (query, opts) => searchPages(db, query, opts),
    get: (id) => findPage(db, id),
    versions: (url) => versionsOf(db, url),
    facets: () => listFacets(db),
    remove(idOrPrefix) {
      const page = findPage(db, idOrPrefix);
      // a dot-name at the root is never scanned as a capture, so a reindex cannot bring back a
      // folder whose removal stopped half way
      const trash = join(root, `.deleting-${page.id}-${process.pid}`);
      try {
        renameSync(join(root, page.dir), trash);
      } catch (err) {
        // a folder already gone from the disk leaves only its index entry to remove
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      removeIndexed(db, page.id);
      rmSync(trash, { recursive: true, force: true });
      return page;
    },
    tag(idOrPrefix, addTags, remove = []) {
      const page = findPage(db, idOrPrefix);
      const metaPath = join(root, page.dir, META_FILE);
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PageMeta;
      const drop = new Set(normalizeTags(remove));
      meta.tags = normalizeTags([...(meta.tags ?? []), ...addTags]).filter((t) => !drop.has(t));
      writeAtomic(metaPath, serializeMeta(meta));
      setIndexedTags(db, page.id, meta.tags);
      return findPage(db, page.id);
    },
    pathOf: (page, file = ARCHIVE_FILE) => join(root, page.dir, file),
    reindex: () => rebuildIndex(db, root),
    close: () => db.close(),
  };
}
