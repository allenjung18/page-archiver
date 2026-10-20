// capture(url): load the page in Chromium, record every response, settle, snapshot the live DOM
// in the page, then (in Node) sanitize, inline every resource from the recorded bytes, stamp,
// and write one self-contained HTML file.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "@page-archiver/serializer";
import type { Frame } from "playwright";
import { ARCHIVE_FILE, TOOL_VERSION } from "./archive.ts";
import { openBrowser, type BrowserOptions } from "./browser.ts";
import { allElements, getAttr, parseDocument, removeAttr, serializeDocument, setAttr, type Document } from "./dom.ts";
import { FRAME_ATTRIBUTE, MAX_FRAME_DEPTH, snapshotFrames, type FrameCapture } from "./frames.ts";
import { createFontFilter } from "./inline/fonts.ts";
import { inlineDocument } from "./inline/html.ts";
import { createRecorder, DEFAULT_RESOURCE_CAP, DEFAULT_TOTAL_CAP } from "./recorder.ts";
import { createResolver, type Resolver } from "./resources.ts";
import { sanitizeDocument, type SanitizeReport } from "./sanitize.ts";
import { settle, trackNetwork, type SettleOptions } from "./settle.ts";
import { canonicalUrl, finalizeStamp, stamp } from "./stamp.ts";
import { sizeWarning, summarizeWarnings } from "./warnings.ts";

export interface CaptureOptions extends BrowserOptions, SettleOptions {
  /** Write the archive as <outDir>/archive.html. */
  outDir?: string | undefined;
  /** Write the archive to this file. */
  outFile?: string | undefined;
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
  /** What the library's meta.json takes from a capture: the archive's size, and the warnings summarized. */
  meta: { bytes: { archive: number }; warnings: string[] };
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
  /** The file written, when outDir or outFile was given. */
  file?: string;
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
  const bundle = serializerBundle();
  const now = opts.now ?? (() => new Date());

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
    stamp(doc, { sourceUrl: parsed.href, canonicalUrl: canonicalUrl(doc), capturedAt, toolVersion: TOOL_VERSION, warnings: summary });
    const { html, sha256 } = finalizeStamp(serializeDocument(doc));

    const archive: Archive = {
      html,
      sourceUrl: parsed.href,
      finalUrl: snap.url,
      title: snap.title,
      capturedAt,
      sha256,
      warnings: all,
      meta: { bytes: { archive: Buffer.byteLength(html) }, warnings: summary },
      stats: { ...resolver.stats, ...built },
    };
    const file = opts.outFile ?? (opts.outDir ? join(opts.outDir, ARCHIVE_FILE) : undefined);
    if (file) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, html, "utf8");
      archive.file = file;
    }
    return archive;
  } finally {
    await session.close();
  }
}

interface BuildContext {
  resolver: Resolver;
  fetched: (url: string) => boolean;
  warn: (message: string) => void;
  built: { removed: SanitizeReport; frames: number; fontFacesDropped: number };
}

/**
 * One frame's snapshot made into a sanitized, self-contained document, its child frames built the
 * same way and written into their <iframe> elements as srcdoc.
 */
async function buildFrame(capture: FrameCapture, ctx: BuildContext): Promise<Document> {
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
    if (el.tagName !== "iframe" && el.tagName !== "frame") continue;
    const id = getAttr(el, FRAME_ATTRIBUTE);
    removeAttr(el, FRAME_ATTRIBUTE);
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
      // a child that is too deep or failed already has its warning
      if (child === undefined) ctx.warn(`${el.tagName} ${src}: ${el.tagName === "frame" ? "<frame> is not supported" : "not loaded by the page"}; left empty`);
      removeAttr(el, "src");
    }
  }
  return doc;
}
