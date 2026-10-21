// `pa import`: an HTML file saved by another tool (SingleFile, mostly) made into a capture like
// one of ours: sanitized (no scripts, no script hooks), stamped, with a reader copy and meta.json.
// Nothing is fetched; what the file holds is what the archive holds. A file page-archiver made
// itself (the Chrome extension's capture, or its downloaded archive.html) keeps its own stamp's
// URL, capture time and warnings: it is a capture, not an import.
import { TOOL_NAME, TOOL_VERSION } from "./archive.ts";
import type { Archive } from "./capture.ts";
import { documentLang } from "./capture.ts";
import { allElements, parseDocument, serializeDocument, textOf } from "./dom.ts";
import { extractReader, renderReader } from "./extras/reader.ts";
import { newPageId, normalizeTags, type PageMeta } from "./meta.ts";
import { sanitizeDocument } from "./sanitize.ts";
import { canonicalUrl, finalizeStamp, readStamp, stamp, verifyStamp } from "./stamp.ts";

/** What SingleFile writes into the comment at the top of every save. */
export interface SingleFileHeader {
  url: string | null;
  savedAt: Date | null;
}

/** Where a saved file says it came from: SingleFile's header comment, or page-archiver's own stamp. */
export interface SavedHeader extends SingleFileHeader {
  tool: "singlefile" | "page-archiver";
  /** The warnings page-archiver stamped into the file (none for SingleFile). */
  warnings: string[];
}

const HEADER_MARK = /saved with SingleFile/i;

/**
 * A date a capture may be filed under, or null: valid, and in the years 1000 to 9999 (a library
 * folder is named by a four-digit year, and an ISO time past 9999 is written "+010000-...").
 */
export function captureDate(d: Date | null): Date | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  return year >= 1000 && year <= 9999 ? d : null;
}

/** The url and saved date from a SingleFile save's header comment; null when it has none. */
export function readSingleFileHeader(html: string): SingleFileHeader | null {
  for (const m of html.slice(0, 64 * 1024).matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = m[1]!;
    if (!HEADER_MARK.test(body)) continue;
    const url = /^\s*url:\s*(\S+)\s*$/m.exec(body)?.[1] ?? null;
    const date = /^\s*saved date:\s*(.+?)\s*$/m.exec(body)?.[1]?.replace(/\s*\([^)]*\)\s*$/, "");
    return { url, savedAt: date ? captureDate(new Date(date)) : null };
  }
  return null;
}

/** The stamp page-archiver wrote into one of its own archives; null when the file has none. */
export function readOwnStamp(html: string): SavedHeader | null {
  const s = readStamp(html.slice(0, 256 * 1024));
  if (!s["source-url"] || !s["captured-at"]) return null;
  const at = new Date(s["captured-at"]);
  let warnings: string[] = [];
  try {
    const parsed: unknown = JSON.parse(s["warnings"] ?? "[]");
    if (Array.isArray(parsed)) warnings = parsed.filter((w): w is string => typeof w === "string");
  } catch {
    // an unreadable warnings meta is dropped, never fatal
  }
  return { tool: "page-archiver", url: s["source-url"], savedAt: captureDate(at), warnings };
}

/**
 * The saved file's header. page-archiver's own stamp wins when its hash still matches the file
 * (an archive exactly as page-archiver wrote it, even of a page that quotes SingleFile's comment);
 * else SingleFile's comment (a SingleFile save, perhaps of one of our archives); else our stamp.
 */
export function readSavedHeader(html: string): SavedHeader | null {
  const own = readOwnStamp(html);
  if (own && verifyStamp(html)) return own;
  const sf = readSingleFileHeader(html);
  if (sf) return { ...sf, tool: "singlefile", warnings: [] };
  return own;
}

export interface ImportOptions {
  /** The page's address; required when the file does not name one. */
  url?: string | undefined;
  /** When the page was saved, when the file does not say (e.g. the file's mtime). */
  savedAt?: Date | undefined;
  /** Make the reader copy (default true). */
  reader?: boolean | undefined;
  tags?: readonly string[] | undefined;
  id?: string | undefined;
  versionOf?: string | undefined;
  /** Where the file came from, for the warning that says it was imported. */
  source?: string | undefined;
}

/**
 * A saved HTML file as an Archive, ready to be written into a capture folder. The file's own
 * header (SingleFile's url and saved date) wins over the options' fallbacks; an explicit
 * `url` wins over the header.
 */
export function importHtml(html: string, opts: ImportOptions = {}): Archive {
  const header = readSavedHeader(html);
  const url = opts.url ?? header?.url ?? null;
  if (!url) throw new Error("the file does not say which URL it was saved from; pass the URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`only http and https pages: ${url}`);
  const capturedAt = header?.savedAt ?? opts.savedAt ?? new Date();

  const doc = parseDocument(html);
  const removed = sanitizeDocument(doc);
  const removedNote = removed.elements || removed.attributes ? [`removed ${removed.elements} script elements and ${removed.attributes} script attributes`] : [];
  let stamped: string[];
  let warnings: string[];
  if (header?.tool === "page-archiver") {
    // one of our own captures: its warnings stand, and nothing says it was imported
    stamped = [...header.warnings, ...removedNote];
    warnings = [...stamped];
  } else {
    const origin = header ? " (SingleFile)" : "";
    // the stamp never names the file, so the same save under another name stamps to the same bytes
    stamped = [`imported from a saved file${origin}`, ...removedNote];
    warnings = [`imported from ${opts.source ?? "a saved file"}${origin}`, ...removedNote];
  }
  const canonical = canonicalUrl(doc);
  stamp(doc, { sourceUrl: parsed.href, canonicalUrl: canonical, capturedAt, toolVersion: TOOL_VERSION, warnings: stamped });
  const { html: archiveHtml, sha256 } = finalizeStamp(serializeDocument(doc));

  let reader: Archive["reader"];
  if (opts.reader !== false) {
    const view = extractReader(archiveHtml, parsed.href);
    if (view) reader = { view, html: renderReader(view, { url: parsed.href, capturedAt }) };
    else warnings.push("no reader copy: no article found in the page");
  }
  const titleEl = allElements(doc).find((e) => e.tagName === "title");
  const docTitle = titleEl ? textOf(titleEl).trim() : "";
  const meta: PageMeta = {
    id: opts.id ?? newPageId(),
    url: parsed.href,
    canonicalUrl: canonical,
    title: reader?.view.title || docTitle || parsed.href,
    byline: reader?.view.byline ?? null,
    site: reader?.view.siteName ?? (parsed.hostname || null),
    excerpt: reader?.view.excerpt ?? null,
    lang: reader?.view.lang ?? documentLang(doc),
    capturedAt: capturedAt.toISOString(),
    ...(opts.versionOf ? { versionOf: opts.versionOf } : {}),
    bytes: { archive: Buffer.byteLength(archiveHtml) },
    sha256,
    tags: normalizeTags(opts.tags ?? []),
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    warnings,
  };
  if (reader) meta.bytes.reader = Buffer.byteLength(reader.html);
  const archive: Archive = {
    html: archiveHtml,
    sourceUrl: parsed.href,
    finalUrl: parsed.href,
    title: meta.title,
    capturedAt,
    sha256,
    warnings,
    meta,
    stats: { recorded: 0, fetched: 0, failed: 0, reused: 0, removed, frames: 0, fontFacesDropped: 0 },
  };
  if (reader) archive.reader = reader;
  return archive;
}
