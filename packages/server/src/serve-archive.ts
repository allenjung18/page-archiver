// Archives are untrusted HTML. Each is served as its own document under ARCHIVE_CSP, which
// allows nothing but inline styles and data: URIs: no script runs (there is no script-src, so
// default-src 'none' refuses inline and external scripts alike) and nothing reaches the
// network. The reader UI shows them in an iframe sandboxed without allow-scripts on top of it.
import { readFile } from "node:fs/promises";
import { ARCHIVE_CSP, ARCHIVE_FILE, READER_FILE } from "@page-archiver/core";

/** The two copies of a page the reader shows. */
export const VIEWS = { original: ARCHIVE_FILE, reader: READER_FILE } as const;
export type View = keyof typeof VIEWS;

export function isView(view: string): view is View {
  return Object.hasOwn(VIEWS, view);
}

/** Every archive response carries exactly these headers. */
export const ARCHIVE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": ARCHIVE_CSP,
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** The archive file at path as a response under ARCHIVE_CSP, or null when there is no such file. */
export async function archiveResponse(path: string, method: string = "GET"): Promise<Response | null> {
  let body: Buffer;
  try {
    body = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const headers = { ...ARCHIVE_HEADERS, "Content-Length": String(body.byteLength) };
  return new Response(method === "HEAD" ? null : new Uint8Array(body), { status: 200, headers });
}
