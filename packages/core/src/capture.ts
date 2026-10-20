// capture(url): load the page in Chromium, record every response, settle, snapshot the live DOM
// in the page, then (in Node) sanitize, inline every resource from the recorded bytes, stamp,
// and write one self-contained HTML file.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "@page-archiver/serializer";
import { ARCHIVE_FILE, TOOL_VERSION } from "./archive.ts";
import { openBrowser, type BrowserOptions } from "./browser.ts";
import { parseDocument, serializeDocument } from "./dom.ts";
import { inlineDocument } from "./inline/html.ts";
import { createRecorder, DEFAULT_RESOURCE_CAP, DEFAULT_TOTAL_CAP } from "./recorder.ts";
import { createResolver } from "./resources.ts";
import { sanitizeDocument } from "./sanitize.ts";
import { settle, trackNetwork, type SettleOptions } from "./settle.ts";
import { canonicalUrl, finalizeStamp, stamp } from "./stamp.ts";

export interface CaptureOptions extends BrowserOptions, SettleOptions {
  /** Write the archive as <outDir>/archive.html. */
  outDir?: string | undefined;
  /** Write the archive to this file. */
  outFile?: string | undefined;
  /** Navigation timeout. Default 60 s. */
  timeoutMs?: number | undefined;
  resourceCap?: number | undefined;
  totalCap?: number | undefined;
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
  stats: { recorded: number; fetched: number; failed: number; reused: number; removed: { elements: number; attributes: number } };
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
    const snap = (await page.evaluate(
      `(() => { ${bundle}\n; return PageArchiverSerializer.snapshot({}); })()`,
    )) as Snapshot;

    const resolver = createResolver({
      recorder,
      resourceCap: opts.resourceCap ?? DEFAULT_RESOURCE_CAP,
      totalCap: opts.totalCap ?? DEFAULT_TOTAL_CAP,
      fallback: async (u) => {
        const res = await page.context().request.get(u, { timeout: 30_000, failOnStatusCode: false });
        return { status: res.status(), mime: res.headers()["content-type"] ?? "", bytes: await res.body() };
      },
    });

    const doc = parseDocument(snap.html);
    const removed = sanitizeDocument(doc);
    await inlineDocument(doc, { baseUrl: snap.baseUrl, get: (u) => resolver.get(u), warn: (m) => warnings.push(m) });
    recorder.stop();
    stamp(doc, { sourceUrl: parsed.href, canonicalUrl: canonicalUrl(doc), capturedAt, toolVersion: TOOL_VERSION });
    const { html, sha256 } = finalizeStamp(serializeDocument(doc));

    const archive: Archive = {
      html,
      sourceUrl: parsed.href,
      finalUrl: snap.url,
      title: snap.title,
      capturedAt,
      sha256,
      warnings: [...warnings, ...resolver.warnings],
      stats: { ...resolver.stats, removed },
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
