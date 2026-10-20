// The archive's provenance, written into its <head> as page-archiver:* metas: where it came
// from, when, by which tool version, and a sha256 that lets anyone check the file is unchanged.
import { createHash } from "node:crypto";
import { allElements, createElement, detach, getAttr, tokens, type Document, type Element } from "./dom.ts";

export const STAMP_PREFIX = "page-archiver:";
const ZERO_HASH = "0".repeat(64);
const HASH_META = /<meta name="page-archiver:sha256" content="([0-9a-f]{64})">/;

export interface StampInfo {
  sourceUrl: string;
  /** The page's <link rel=canonical>, when it has one. */
  canonicalUrl?: string | null;
  capturedAt: Date;
  toolVersion: string;
  /** The capture's warnings, summarized; written as a JSON array when there are any. */
  warnings?: readonly string[] | undefined;
}

/** The page's canonical URL (its <link rel=canonical href>), or null. */
export function canonicalUrl(doc: Document): string | null {
  const link = allElements(doc).find((e) => e.tagName === "link" && tokens(e, "rel").includes("canonical"));
  return (link && getAttr(link, "href")) || null;
}

function head(doc: Document): Element {
  const html = doc.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "html");
  const h = html?.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "head");
  if (!h) throw new Error("document has no <head>"); // parse5 always creates one
  return h;
}

/**
 * Writes `<meta charset="utf-8">` first in <head> (the archive is always UTF-8; any other charset
 * declaration goes) followed by the stamp metas. The sha256 meta holds zeros until
 * finalizeStamp() fills it in on the serialized file.
 */
export function stamp(doc: Document, info: StampInfo): void {
  const h = head(doc);
  for (const el of allElements(h)) {
    if (el.tagName !== "meta") continue;
    const name = getAttr(el, "name") ?? "";
    const equiv = (getAttr(el, "http-equiv") ?? "").toLowerCase();
    if (getAttr(el, "charset") !== null || equiv === "content-type" || name.startsWith(STAMP_PREFIX)) detach(el);
  }
  const metas: Element[] = [createElement("meta", { charset: "utf-8" })];
  const add = (name: string, content: string) => metas.push(createElement("meta", { name: STAMP_PREFIX + name, content }));
  add("source-url", info.sourceUrl);
  if (info.canonicalUrl) add("canonical-url", info.canonicalUrl);
  add("captured-at", info.capturedAt.toISOString());
  add("tool-version", info.toolVersion);
  if (info.warnings?.length) add("warnings", JSON.stringify(info.warnings));
  add("sha256", ZERO_HASH);
  for (const m of metas) m.parentNode = h;
  h.childNodes.unshift(...metas);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Fills the sha256 meta of a serialized, stamped archive: the hash of the whole file as it reads
 * with that meta's content set to 64 zeros.
 */
export function finalizeStamp(html: string): { html: string; sha256: string } {
  const m = HASH_META.exec(html);
  if (!m || m[1] !== ZERO_HASH) throw new Error("archive has no unfilled page-archiver:sha256 meta");
  const hash = sha256(html);
  return { html: html.replace(HASH_META, `<meta name="page-archiver:sha256" content="${hash}">`), sha256: hash };
}

/** True when the archive's sha256 meta matches its content. */
export function verifyStamp(html: string): boolean {
  const m = HASH_META.exec(html);
  if (!m) return false;
  return sha256(html.replace(HASH_META, `<meta name="page-archiver:sha256" content="${ZERO_HASH}">`)) === m[1];
}

/** The page-archiver:* metas of an archive, by name without the prefix. */
export function readStamp(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta name="page-archiver:([a-z0-9-]+)" content="([^"]*)">/g)) out[m[1]!] = m[2]!.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  return out;
}
