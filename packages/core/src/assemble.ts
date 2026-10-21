// The half of a capture that needs no browser: a frame tree of snapshots, plus a way to get each
// resource's bytes, made into one sanitized, inlined, stamped archive. capture() runs it in Node
// over the responses it recorded; the Chrome extension runs it in its service worker over bytes
// it fetches there. Nothing reachable from this file may import Node or Playwright at run time:
// the extension bundles it (with a sha256 stand-in for node:crypto).
import { TOOL_VERSION } from "./archive.ts";
import { utf8Length } from "./bytes.ts";
import { allElements, getAttr, parseDocument, removeAttr, serializeDocument, setAttr, type Document } from "./dom.ts";
import { FRAME_ATTRIBUTE, type FrameCapture } from "./frames.ts";
import { createFontFilter } from "./inline/fonts.ts";
import { inlineDocument, UNFETCHED_ATTRIBUTE_PREFIX } from "./inline/html.ts";
import type { Resolver } from "./resources.ts";
import { sanitizeDocument, type SanitizeReport } from "./sanitize.ts";
import { canonicalUrl, finalizeStamp, stamp } from "./stamp.ts";
import { sizeWarning, summarizeWarnings } from "./warnings.ts";

export interface BuildContext {
  resolver: Resolver;
  /** True when the browser fetched this URL while the page loaded (narrows a font's src list). */
  fetched?: ((url: string) => boolean) | undefined;
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
  await inlineDocument(doc, { baseUrl: snap.baseUrl, pageUrl: snap.url, get: (u) => ctx.resolver.get(u), warn: ctx.warn, fonts, fetched: ctx.fetched });
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
    // Not captured: left empty. Its own srcdoc (sanitized, never inlined) would load its resources
    // from the live site when the file is opened from disk, so it is set aside, kept in
    // `data-page-archiver-unfetched-srcdoc` where nothing reads it.
    const src = getAttr(el, "src");
    const live = src !== null && src.trim() !== "" && !/^about:/i.test(src.trim());
    const srcdoc = el.tagName === "iframe" ? getAttr(el, "srcdoc") : null;
    if (srcdoc !== null) {
      removeAttr(el, "srcdoc");
      setAttr(el, UNFETCHED_ATTRIBUTE_PREFIX + "srcdoc", srcdoc);
    }
    if (live) removeAttr(el, "src");
    // a child that is too deep or failed (null) already has its warning; a captured <frame> does not
    if (child !== null && (live || srcdoc !== null)) {
      const reason = el.tagName === "frame" ? "<frame> is not supported" : live ? "not loaded by the page" : "not captured";
      ctx.warn(`${el.tagName} ${live ? src : "srcdoc"}: ${reason}; left empty${srcdoc !== null ? ", its srcdoc set aside" : ""}`);
    }
  }
  return doc;
}

export interface AssembleOptions {
  /** The snapshots: the top document and its frames. */
  tree: FrameCapture;
  /** The URL asked for, stamped as the archive's source. */
  sourceUrl: string;
  capturedAt: Date;
  resolver: Resolver;
  fetched?: ((url: string) => boolean) | undefined;
  /** Warnings from before the snapshot (loading, settling, frames), first in the list. */
  warnings?: readonly string[] | undefined;
}

export interface Assembled {
  /** The stamped document (its sha256 meta still zeros; `html` has it filled). */
  doc: Document;
  html: string;
  sha256: string;
  canonicalUrl: string | null;
  /** Every warning, one line each. */
  warnings: string[];
  /** The warnings as stamped into the file. */
  summary: string[];
  built: BuildContext["built"];
}

/** Builds the frame tree into one archive: sanitized, every resource inlined, stamped. */
export async function assemble(opts: AssembleOptions): Promise<Assembled> {
  const warnings = [...(opts.warnings ?? [])];
  const built = { removed: { elements: 0, attributes: 0 }, frames: 0, fontFacesDropped: 0 };
  const doc = await buildFrame(opts.tree, { resolver: opts.resolver, fetched: opts.fetched, warn: (m) => warnings.push(m), built });
  const all = [...warnings, ...opts.resolver.warnings];
  const tooBig = sizeWarning(utf8Length(serializeDocument(doc)));
  if (tooBig) all.push(tooBig);
  const summary = summarizeWarnings(all);
  const canonical = canonicalUrl(doc);
  stamp(doc, { sourceUrl: opts.sourceUrl, canonicalUrl: canonical, capturedAt: opts.capturedAt, toolVersion: TOOL_VERSION, warnings: summary });
  const { html, sha256 } = finalizeStamp(serializeDocument(doc));
  return { doc, html, sha256, canonicalUrl: canonical, warnings: all, summary, built };
}
