// capture(url): load the page in Chromium, record every response, settle, snapshot the live DOM
// in the page, then (in Node) sanitize, inline every resource from the recorded bytes, stamp,
// and write one self-contained HTML file. With a folder to write to, it also makes the extras
// (a reader copy, an MHTML copy, a full-page PNG and PDF) and the folder's meta.json.
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "@page-archiver/serializer";
import type { Frame } from "playwright";
import { ARCHIVE_FILE, TOOL_NAME, TOOL_VERSION } from "./archive.ts";
import { openBrowser, type BrowserOptions } from "./browser.ts";
import { allElements, getAttr, isElement, parseDocument, removeAttr, serializeDocument, setAttr, type Document } from "./dom.ts";
import { captureMhtml, MHTML_FILE } from "./extras/mhtml.ts";
import { extractReader, READER_FILE, renderReader, type ReaderView } from "./extras/reader.ts";
import { PDF_FILE, PNG_FILE, printPdf, screenshotPng } from "./extras/shot.ts";
import { FRAME_ATTRIBUTE, MAX_FRAME_DEPTH, snapshotFrames, type FrameCapture } from "./frames.ts";
import { createFontFilter } from "./inline/fonts.ts";
import { inlineDocument } from "./inline/html.ts";
import { META_FILE, newPageId, normalizeTags, serializeMeta, type PageMeta } from "./meta.ts";
import { createRecorder, DEFAULT_RESOURCE_CAP, DEFAULT_TOTAL_CAP } from "./recorder.ts";
import { createResolver, type Resolver } from "./resources.ts";
import { sanitizeDocument, type SanitizeReport } from "./sanitize.ts";
import { settle, trackNetwork, type SettleOptions } from "./settle.ts";
import { canonicalUrl, finalizeStamp, stamp } from "./stamp.ts";
import { sizeWarning, summarizeWarnings } from "./warnings.ts";

/** What a capture makes besides archive.html. */
export interface Extras {
  /** reader.html (Readability). */
  reader?: boolean | undefined;
  /** archive.mhtml (Chromium's MHTML of the live page). */
  mhtml?: boolean | undefined;
  /** shot.png, a full-page screenshot. */
  png?: boolean | undefined;
  /** shot.pdf (headless only). */
  pdf?: boolean | undefined;
}

export interface CaptureOptions extends BrowserOptions, SettleOptions {
  /**
   * Write the capture into this folder: archive.html, the extras asked for (all of them unless
   * `extras` says otherwise) and meta.json.
   */
  outDir?: string | undefined;
  /** Write the archive alone to this file (no extras unless `extras` asks, and none written). */
  outFile?: string | undefined;
  /** Which extras to make. Default: all with outDir, none otherwise. */
  extras?: Extras | undefined;
  /** meta.json's tags. */
  tags?: readonly string[] | undefined;
  /** meta.json's id. Default: a new random one. */
  id?: string | undefined;
  /** The id of the capture this one is a newer version of. */
  versionOf?: string | undefined;
  /** Navigation timeout. Default 60 s. */
  timeoutMs?: number | undefined;
  resourceCap?: number | undefined;
  totalCap?: number | undefined;
  /** Frames nested deeper than this are left empty. Default 5. */
  maxFrameDepth?: number | undefined;
  /** The clock (tests). */
  now?: (() => Date) | undefined;
}

export interface Archive {
  html: string;
  /** The URL asked for. */
  sourceUrl: string;
  /** Where the page ended up (redirects, client routing). */
  finalUrl: string;
  title: string;
  capturedAt: Date;
  sha256: string;
  /** One line each; a capture with warnings is still a capture. */
  warnings: string[];
  /** The capture's meta.json. */
  meta: PageMeta;
  /** The reader copy, when asked for and the page has an article. */
  reader?: { view: ReaderView; html: string };
  mhtml?: string;
  png?: Buffer;
  pdf?: Buffer;
  stats: {
    recorded: number;
    fetched: number;
    failed: number;
    reused: number;
    removed: { elements: number; attributes: number };
    /** Frames written into the archive as srcdoc. */
    frames: number;
    /** @font-face rules dropped because the page never loaded their face. */
    fontFacesDropped: number;
  };
  /** The archive file written, when outDir or outFile was given. */
  file?: string;
  /** Every file written, by kind (outDir). */
  files?: { archive: string; reader?: string; mhtml?: string; png?: string; pdf?: string; meta: string };
}

/** The extras to make: each one asked for, else all of them for a folder and none for a file. */
export function resolveExtras(opts: Pick<CaptureOptions, "outDir" | "extras">): Required<{ [K in keyof Extras]: boolean }> {
  const all = Boolean(opts.outDir);
  const e = opts.extras ?? {};
  return { reader: e.reader ?? all, mhtml: e.mhtml ?? all, png: e.png ?? all, pdf: e.pdf ?? all };
}

/** The <html lang> of a document, or null. */
export function documentLang(doc: Document): string | null {
  const html = doc.childNodes.find((n) => isElement(n) && n.tagName === "html");
  const lang = html && isElement(html) ? getAttr(html, "lang")?.trim() : undefined;
  return lang || null;
}

/** An extra that fails is a warning, never a failed capture. */
async function attempt<T>(what: string, warn: (m: string) => void, make: () => Promise<T>): Promise<T | undefined> {
  try {
    return await make();
  } catch (err) {
    warn(`no ${what}: ${(err as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

let serializerSource: string | undefined;

/** The serializer IIFE (packages/serializer/dist/serializer.iife.js). */
export function serializerBundle(): string {
  serializerSource ??= readFileSync(fileURLToPath(import.meta.resolve("@page-archiver/serializer/iife")), "utf8");
  return serializerSource;
}

export async function capture(url: string, opts: CaptureOptions = {}): Promise<Archive> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`only http and https pages can be captured: ${url}`);
  if (opts.outDir && opts.outFile) throw new Error("capture takes outDir or outFile, not both");
  const bundle = serializerBundle();
  const now = opts.now ?? (() => new Date());
  const extras = resolveExtras(opts);

  const session = await openBrowser(opts);
  try {
    const page = await session.context.newPage();
    const recorder = createRecorder(page, { resourceCap: opts.resourceCap, totalCap: opts.totalCap });
    const network = trackNetwork(page);
    const warnings: string[] = [];

    const response = await page.goto(parsed.href, { waitUntil: "load", timeout: opts.timeoutMs ?? 60_000 });
    if (!response) warnings.push("navigation returned no response");
    else if (response.status() >= 400) warnings.push(`the page answered HTTP ${response.status()}`);
    warnings.push(...(await settle(page, network, opts)));
    network.dispose();

    const capturedAt = now();
    const script = `(() => { ${bundle}\n; return PageArchiverSerializer.snapshot({}); })()`;
    const tree = await snapshotFrames(page.mainFrame(), (f: Frame) => f.evaluate(script) as Promise<Snapshot>, {
      maxDepth: opts.maxFrameDepth ?? MAX_FRAME_DEPTH,
      warn: (m) => warnings.push(m),
    });
    const snap = tree.snap;

    const resolver = createResolver({
      recorder,
      resourceCap: opts.resourceCap ?? DEFAULT_RESOURCE_CAP,
      totalCap: opts.totalCap ?? DEFAULT_TOTAL_CAP,
      fallback: async (u) => {
        const res = await page.context().request.get(u, { timeout: 30_000, failOnStatusCode: false });
        return { status: res.status(), mime: res.headers()["content-type"] ?? "", bytes: await res.body() };
      },
    });

    const built = { removed: { elements: 0, attributes: 0 }, frames: 0, fontFacesDropped: 0 };
    const doc = await buildFrame(tree, { resolver, fetched: (u) => recorder.has(u), warn: (m) => warnings.push(m), built });
    recorder.stop();
    const all = [...warnings, ...resolver.warnings];
    const tooBig = sizeWarning(Buffer.byteLength(serializeDocument(doc)));
    if (tooBig) all.push(tooBig);
    const summary = summarizeWarnings(all);
    const canonical = canonicalUrl(doc);
    stamp(doc, { sourceUrl: parsed.href, canonicalUrl: canonical, capturedAt, toolVersion: TOOL_VERSION, warnings: summary });
    const { html, sha256 } = finalizeStamp(serializeDocument(doc));

    // the extras: MHTML and pictures from the live page (still as it was snapshotted), the
    // reader copy from the finished archive, whose images are already inlined
    const extraWarnings: string[] = [];
    const warnExtra = (m: string) => extraWarnings.push(m);
    const mhtml = extras.mhtml ? await attempt("MHTML copy", warnExtra, () => captureMhtml(page)) : undefined;
    const png = extras.png ? await attempt("screenshot", warnExtra, () => screenshotPng(page)) : undefined;
    let pdf: Buffer | undefined;
    if (extras.pdf && opts.headed) warnExtra("no PDF: Chromium prints PDFs only when headless");
    else if (extras.pdf) pdf = await attempt("PDF", warnExtra, () => printPdf(page));
    let reader: Archive["reader"];
    if (extras.reader) {
      const view = await attempt("reader copy", warnExtra, async () => extractReader(html, snap.url || parsed.href));
      if (view) reader = { view, html: renderReader(view, { url: parsed.href, capturedAt }) };
      else if (view === null) warnExtra("no reader copy: no article found in the page");
    }
    all.push(...extraWarnings);

    let finalHost: string | null = null;
    try {
      finalHost = new URL(snap.url || parsed.href).hostname || null;
    } catch {
      finalHost = parsed.hostname;
    }
    const meta: PageMeta = {
      id: opts.id ?? newPageId(),
      url: parsed.href,
      canonicalUrl: canonical,
      title: reader?.view.title || snap.title.trim() || parsed.href,
      byline: reader?.view.byline ?? null,
      site: reader?.view.siteName ?? finalHost,
      excerpt: reader?.view.excerpt ?? null,
      lang: reader?.view.lang ?? documentLang(doc),
      capturedAt: capturedAt.toISOString(),
      ...(opts.versionOf ? { versionOf: opts.versionOf } : {}),
      bytes: { archive: Buffer.byteLength(html) },
      sha256,
      tags: normalizeTags(opts.tags ?? []),
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      warnings: [...summary, ...extraWarnings],
    };
    if (reader) meta.bytes.reader = Buffer.byteLength(reader.html);
    if (mhtml !== undefined) meta.bytes.mhtml = Buffer.byteLength(mhtml);
    if (png) meta.bytes.png = png.length;
    if (pdf) meta.bytes.pdf = pdf.length;

    const archive: Archive = {
      html,
      sourceUrl: parsed.href,
      finalUrl: snap.url,
      title: snap.title,
      capturedAt,
      sha256,
      warnings: all,
      meta,
      stats: { ...resolver.stats, ...built },
    };
    if (reader) archive.reader = reader;
    if (mhtml !== undefined) archive.mhtml = mhtml;
    if (png) archive.png = png;
    if (pdf) archive.pdf = pdf;

    if (opts.outFile) {
      await mkdir(dirname(opts.outFile), { recursive: true });
      await writeFile(opts.outFile, html, "utf8");
      archive.file = opts.outFile;
    } else if (opts.outDir) {
      archive.files = await writeCapture(opts.outDir, archive);
      archive.file = archive.files.archive;
    }
    return archive;
  } finally {
    await session.close();
  }
}

/** Every file a capture may write into its folder, meta.json last. */
export const CAPTURE_FILES = [ARCHIVE_FILE, READER_FILE, MHTML_FILE, PNG_FILE, PDF_FILE, META_FILE] as const;

/**
 * Writes a capture's files into dir, meta.json last (its presence means the folder is complete).
 * A folder that already holds a capture is overwritten: its meta.json goes first, and any extra
 * this capture did not make goes too, so nothing of the old capture is left beside the new one.
 */
async function writeCapture(dir: string, archive: Archive): Promise<NonNullable<Archive["files"]>> {
  await mkdir(dir, { recursive: true });
  for (const name of [META_FILE, ...CAPTURE_FILES.filter((f) => f !== META_FILE)]) await rm(join(dir, name), { force: true });
  const files: NonNullable<Archive["files"]> = { archive: join(dir, ARCHIVE_FILE), meta: join(dir, META_FILE) };
  await writeFile(files.archive, archive.html, "utf8");
  if (archive.reader) await writeFile((files.reader = join(dir, READER_FILE)), archive.reader.html, "utf8");
  if (archive.mhtml !== undefined) await writeFile((files.mhtml = join(dir, MHTML_FILE)), archive.mhtml, "utf8");
  if (archive.png) await writeFile((files.png = join(dir, PNG_FILE)), archive.png);
  if (archive.pdf) await writeFile((files.pdf = join(dir, PDF_FILE)), archive.pdf);
  await writeFile(files.meta, serializeMeta(archive.meta), "utf8");
  return files;
}

export interface BuildContext {
  resolver: Resolver;
  fetched: (url: string) => boolean;
  warn: (message: string) => void;
  built: { removed: SanitizeReport; frames: number; fontFacesDropped: number };
}

/**
 * One frame's snapshot made into a sanitized, self-contained document, its child frames built the
 * same way and written into their <iframe> elements as srcdoc.
 */
export async function buildFrame(capture: FrameCapture, ctx: BuildContext): Promise<Document> {
  const { snap } = capture;
  for (const w of snap.warnings ?? []) ctx.warn(capture.depth ? `frame ${capture.url}: ${w}` : w);
  const doc = parseDocument(snap.html);
  const removed = sanitizeDocument(doc);
  ctx.built.removed.elements += removed.elements;
  ctx.built.removed.attributes += removed.attributes;
  const fonts = createFontFilter(snap.fonts);
  await inlineDocument(doc, { baseUrl: snap.baseUrl, get: (u) => ctx.resolver.get(u), warn: ctx.warn, fonts, fetched: ctx.fetched });
  ctx.built.fontFacesDropped += fonts?.dropped ?? 0;

  for (const el of allElements(doc)) {
    // <object> and <embed> documents are frames too, and are marked; only iframes become srcdoc
    const id = getAttr(el, FRAME_ATTRIBUTE);
    if (id !== null) removeAttr(el, FRAME_ATTRIBUTE);
    if (el.tagName !== "iframe" && el.tagName !== "frame") continue;
    const child = id ? capture.children.get(id) : undefined;
    if (child && el.tagName === "iframe") {
      const inner = await buildFrame(child, ctx);
      removeAttr(el, "src");
      removeAttr(el, "loading");
      removeAttr(el, "srcdoc");
      setAttr(el, "srcdoc", serializeDocument(inner));
      ctx.built.frames++;
      continue;
    }
    const src = getAttr(el, "src");
    if (src !== null && src.trim() && !/^about:/i.test(src.trim())) {
      // a child that is too deep or failed (null) already has its warning; a captured <frame> does not
      if (child !== null) ctx.warn(`${el.tagName} ${src}: ${el.tagName === "frame" ? "<frame> is not supported" : "not loaded by the page"}; left empty`);
      removeAttr(el, "src");
    }
  }
  return doc;
}
