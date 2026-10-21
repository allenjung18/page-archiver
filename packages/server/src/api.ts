// The local HTTP API over one library, and the reader UI it serves.
//
//   GET    /api/pages              the newest version of each page (filters: site, tag, since, until, all, limit)
//   GET    /api/search?q=…         full-text search, the same filters; each hit's snippet as marked segments
//   GET    /api/facets             the sites and tags to filter by, with counts
//   GET    /api/pages/:id          one page and the versions of its URL
//   POST   /api/save               { url, tags? } capture a URL into the library          (token)
//                                  { url, html, tags? } add a capture made elsewhere: the Chrome
//                                  extension's archive of the tab it was shown, sanitized again
//   POST   /api/pages/:id/recapture  capture the page's URL again, as its next version  (token)
//   POST   /api/pages/:id/tags     { add?, remove? }                                      (token)
//   DELETE /api/pages/:id          delete one capture                                     (token)
//   GET    /archive/:id/original | /archive/:id/reader   the page under ARCHIVE_CSP
//   GET    /                       the reader UI (the token is written into it)
//
// Writes need `Authorization: Bearer <token>`, which no archived page and no other site can
// send: archives run no script, and another origin's request with that header is preflighted
// and gets no CORS answer. Every request must name exactly the address and port the server
// bound (`127.0.0.1:<port>`) in its Host header, so a page at a public name that resolves to
// 127.0.0.1 (`127.0.0.1.nip.io`, DNS rebinding) cannot read the library or the token page.
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { AlreadySavedError, QueryError, type Filters, type Library, type PageRecord, type SearchHit } from "@page-archiver/library";
import { archiveResponse, isView, VIEWS } from "./serve-archive.ts";

/** Where `vite build` writes the UI: packages/server/dist/ui (the same path from src/ and dist/). */
export const DEFAULT_UI_DIR = fileURLToPath(new URL("../dist/ui/", import.meta.url));

/** The reader UI's own policy: its scripts and styles, the API, and archives in frames. */
export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** What the snippet's hits are wrapped in before they are split into segments. */
const OPEN = "";
const CLOSE = "";

export interface Segment {
  text: string;
  hit: boolean;
}

export type Hit = Omit<SearchHit, "snippet"> & { snippet: Segment[] };

export interface AppOptions {
  library: Library;
  /** The write token. */
  token: string;
  /** The host:port requests must name, exactly: the address and port the server bound, filled
   *  in once it knows its port. Any other Host, `localhost` included, is refused. */
  hosts: ReadonlySet<string>;
  uiDir?: string | undefined;
}

/** A snippet with OPEN/CLOSE around each hit, as plain and marked runs of text. */
export function segments(snippet: string): Segment[] {
  const out: Segment[] = [];
  for (const [i, part] of snippet.split(new RegExp(`[${OPEN}${CLOSE}]`)).entries()) {
    if (part) out.push({ text: part, hit: i % 2 === 1 });
  }
  return out;
}

class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 503;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

function filtersOf(c: Context): Filters {
  const q = (k: string) => c.req.query(k) || undefined;
  const limit = q("limit");
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) throw new HttpError(400, `limit takes a whole number above 0: ${limit}`);
  return {
    site: q("site"),
    tags: c.req.queries("tag")?.filter(Boolean) ?? [],
    since: q("since"),
    until: q("until"),
    allVersions: q("all") === "1" || q("all") === "true",
    limit: limit === undefined ? undefined : Number(limit),
  };
}

function pageOf(lib: Library, id: string): PageRecord {
  try {
    return lib.get(id);
  } catch (err) {
    if (err instanceof QueryError) throw new HttpError(404, err.message);
    throw err;
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "the body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "the body must be a JSON object");
  return body as Record<string, unknown>;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new HttpError(400, `${name} must be a list of strings`);
  return value as string[];
}

function httpUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "url must be a string");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(400, `not a URL: ${value}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, `only http and https URLs: ${value}`);
  return value;
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Hono app: the API, the archive route and the UI, for one library. */
export function createApp(opts: AppOptions): Hono {
  const { library: lib, token } = opts;
  const uiDir = opts.uiDir ?? DEFAULT_UI_DIR;
  const app = new Hono();
  // a capture never fetches this server for the page it saves (its UI page carries the token)
  const ownUrl = () => {
    const own = [...opts.hosts][0];
    return own ? `http://${own}/` : undefined;
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof QueryError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: (err as Error).message }, 500);
  });

  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    const urlHost = new URL(c.req.url).host;
    if (!opts.hosts.has(urlHost) || (host !== undefined && !opts.hosts.has(host))) {
      const own = [...opts.hosts][0];
      return c.json({ error: `not this server's host: ${host ?? urlHost}${own ? `; open http://${own}/` : ""}` }, 403);
    }
    await next();
  });

  const write: MiddlewareHandler = async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const given = /^Bearer (\S+)$/.exec(auth)?.[1];
    if (!given || !sameToken(given, token)) throw new HttpError(401, "a write needs the server's token (Authorization: Bearer <token>)");
    await next();
  };

  app.get("/api/pages", (c) => c.json(lib.list(filtersOf(c))));

  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) throw new HttpError(400, "q: words to search for");
    const hits = lib.search(q, { ...filtersOf(c), mark: { open: OPEN, close: CLOSE }, snippetWords: 24 });
    return c.json(hits.map((h): Hit => ({ ...h, snippet: segments(h.snippet) })));
  });

  app.get("/api/facets", (c) => c.json(lib.facets()));

  app.get("/api/pages/:id", (c) => {
    const page = pageOf(lib, c.req.param("id"));
    return c.json({ page, versions: lib.versions(page.url) });
  });

  app.post("/api/save", write, async (c) => {
    const body = await jsonBody(c);
    const url = httpUrl(body["url"]);
    const tags = stringList(body["tags"], "tags");
    const html = body["html"];
    if (html === undefined) {
      const { page, archive } = await lib.save(url, { tags, server: ownUrl() });
      return c.json({ page, warnings: archive.warnings }, 201);
    }
    // the page as the reader's own browser had it (logins, paywalls): untrusted HTML, which the
    // import sanitizes again whatever it claims to be
    if (typeof html !== "string" || !html.trim()) throw new HttpError(400, "html must be the archive's text");
    try {
      const { page, archive } = await lib.importHtml(html, { url, tags, source: "the Chrome extension" });
      return c.json({ page, warnings: archive.warnings }, 201);
    } catch (err) {
      if (err instanceof AlreadySavedError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  app.post("/api/pages/:id/recapture", write, async (c) => {
    const old = pageOf(lib, c.req.param("id"));
    const { page, archive } = await lib.save(old.url, { server: ownUrl() });
    return c.json({ page, warnings: archive.warnings }, 201);
  });

  app.post("/api/pages/:id/tags", write, async (c) => {
    const page = pageOf(lib, c.req.param("id"));
    const body = await jsonBody(c);
    return c.json(lib.tag(page.id, stringList(body["add"], "add"), stringList(body["remove"], "remove")));
  });

  app.delete("/api/pages/:id", write, (c) => {
    const page = pageOf(lib, c.req.param("id"));
    lib.remove(page.id);
    return c.json({ deleted: page.id });
  });

  app.on(["GET", "HEAD"], "/archive/:id/:view", async (c) => {
    const view = c.req.param("view");
    if (!isView(view)) throw new HttpError(404, `no such view: ${view} (original or reader)`);
    const page = pageOf(lib, c.req.param("id"));
    const res = await archiveResponse(lib.pathOf(page, VIEWS[view]), c.req.method);
    if (!res) throw new HttpError(404, `${page.id} has no ${view} copy`);
    return res;
  });

  const uiHeaders = { "Content-Security-Policy": UI_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

  app.get("/", async (c) => {
    let html: string;
    try {
      html = await readFile(join(uiDir, "index.html"), "utf8");
    } catch {
      throw new HttpError(503, "the reader UI is not built: npm run build");
    }
    // the token is hex, so it needs no escaping
    html = html.replace('<meta name="pa-token" content="">', `<meta name="pa-token" content="${token}">`);
    return c.body(html, 200, { ...uiHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  });

  const TYPES: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    const ext = /^[\w.-]+(\.[a-z0-9]+)$/.exec(file)?.[1];
    const type = ext ? TYPES[ext] : undefined;
    if (!type || file.startsWith(".")) throw new HttpError(404, `no such file: ${file}`);
    let body: Buffer;
    try {
      body = await readFile(join(uiDir, "assets", file));
    } catch {
      throw new HttpError(404, `no such file: ${file}`);
    }
    return c.body(new Uint8Array(body), 200, { ...uiHeaders, "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" });
  });

  app.notFound((c) => c.json({ error: `not found: ${c.req.path}` }, 404));
  return app;
}
