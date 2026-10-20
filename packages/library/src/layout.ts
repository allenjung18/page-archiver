// The library is a folder: <root>/YYYY/MM/<slug>-<id>/ per capture, holding archive.html,
// reader.html, meta.json and the other extras. meta.json is written last, so a folder without
// one is an unfinished capture and is passed over. The index (library.db, at the root) is
// rebuilt from these folders and holds nothing they do not.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ARCHIVE_FILE, META_FILE, READER_FILE, type PageMeta } from "@page-archiver/core";
import { archiveText, readerText } from "./text.ts";

/** Where the library lives when nothing else says. */
export const DEFAULT_LIBRARY_DIR = "~/Archive/pages";
/** The environment variable that moves the library. */
export const LIBRARY_ENV = "PA_LIBRARY";
/** The index's file name, at the library's root. */
export const DB_FILE = "library.db";

/**
 * The library's root: the given directory, else $PA_LIBRARY, else ~/Archive/pages. A leading
 * `~/` is the home directory. Always absolute.
 */
export function resolveLibraryDir(dir?: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = dir || env[LIBRARY_ENV] || DEFAULT_LIBRARY_DIR;
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  return resolve(expanded);
}

/** A folder-name slug: lower-case ASCII letters and digits joined by dashes, at most `max` long. */
export function slugify(title: string, max = 60): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.length > max ? slug.slice(0, max).replace(/-[^-]*$/, "") || slug.slice(0, max) : slug;
  return cut.replace(/-+$/g, "") || "page";
}

/** A capture's folder, relative to the library root: YYYY/MM/<slug>-<id>, the month in UTC. */
export function captureFolder(meta: Pick<PageMeta, "id" | "title" | "capturedAt">): string {
  const at = new Date(meta.capturedAt);
  if (Number.isNaN(at.getTime())) throw new Error(`capture ${meta.id} has no valid capturedAt: ${meta.capturedAt}`);
  const yyyy = String(at.getUTCFullYear()).padStart(4, "0");
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${slugify(meta.title)}-${meta.id}`;
}

/** What the index holds for one capture folder. */
export interface FolderEntry {
  /** The folder, relative to the library root (always with `/`). */
  dir: string;
  meta: PageMeta;
  /** The text that is searched: the reader copy's article, else the archive's body. */
  text: string;
  hasReader: boolean;
}

/** One folder that could not be indexed, and why. */
export interface Skipped {
  dir: string;
  reason: string;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function sortedNames(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir)
    .filter((n) => pattern.test(n) && isDir(join(dir, n)))
    .sort();
}

/** Every capture folder under root (YYYY/MM/<name>), in path order. */
export function listCaptureFolders(root: string): string[] {
  if (!isDir(root)) return [];
  const out: string[] = [];
  for (const y of sortedNames(root, /^\d{4}$/)) {
    for (const m of sortedNames(join(root, y), /^\d{2}$/)) {
      for (const name of sortedNames(join(root, y, m), /^[^.]/)) out.push(`${y}/${m}/${name}`);
    }
  }
  return out;
}

function checkMeta(value: unknown): PageMeta {
  const m = value as Partial<PageMeta> | null;
  if (!m || typeof m !== "object") throw new Error("meta.json is not an object");
  for (const k of ["id", "url", "title", "capturedAt"] as const) {
    if (typeof m[k] !== "string" || !m[k]) throw new Error(`meta.json has no ${k}`);
  }
  if (!/^[0-9a-z]{12}$/.test(m.id!)) throw new Error(`meta.json has a malformed id: ${m.id}`);
  if (Number.isNaN(new Date(m.capturedAt!).getTime())) throw new Error(`meta.json has a malformed capturedAt: ${m.capturedAt}`);
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== "string"))) throw new Error("meta.json tags is not a list of strings");
  return { ...m, tags: m.tags ?? [] } as PageMeta;
}

/** Reads one capture folder; throws when its meta.json is missing or unusable. */
export function readCaptureFolder(root: string, dir: string): FolderEntry {
  const abs = join(root, dir);
  const metaPath = join(abs, META_FILE);
  if (!existsSync(metaPath)) throw new Error("no meta.json (an unfinished capture)");
  const meta = checkMeta(JSON.parse(readFileSync(metaPath, "utf8")));
  const readerPath = join(abs, READER_FILE);
  if (existsSync(readerPath)) return { dir, meta, text: readerText(readFileSync(readerPath, "utf8")), hasReader: true };
  const archivePath = join(abs, ARCHIVE_FILE);
  const text = existsSync(archivePath) ? archiveText(readFileSync(archivePath, "utf8")) : "";
  return { dir, meta, text, hasReader: false };
}

/** Every readable capture folder under root, and the ones that could not be read. */
export function scanLibrary(root: string): { entries: FolderEntry[]; skipped: Skipped[] } {
  const entries: FolderEntry[] = [];
  const skipped: Skipped[] = [];
  const seen = new Map<string, string>();
  for (const dir of listCaptureFolders(root)) {
    let entry: FolderEntry;
    try {
      entry = readCaptureFolder(root, dir);
    } catch (err) {
      skipped.push({ dir, reason: (err as Error).message });
      continue;
    }
    const other = seen.get(entry.meta.id);
    if (other) {
      skipped.push({ dir, reason: `id ${entry.meta.id} is already used by ${other}` });
      continue;
    }
    seen.set(entry.meta.id, dir);
    entries.push(entry);
  }
  return { entries, skipped };
}
