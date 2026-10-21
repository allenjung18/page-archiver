// The fixture server: test pages on one port, their assets on a second port, so every asset is
// cross origin on purpose (the capture must never rely on same-origin access to a resource).
//
//   node fixtures/server.ts            pages on 47310, assets on 47311
//   PAGES_PORT=0 ASSETS_PORT=0 ...     any free ports (printed)
//
// Pages may write {{ASSETS}}; it is replaced by the assets origin when served. {{ASSETS_LOCALHOST}}
// is the same server by another loopback name (http://localhost:<assets port>), which a capture
// must refuse to fetch for a page at 127.0.0.1.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PAGES_PORT = 47310;
export const DEFAULT_ASSETS_PORT = 47311;
export const HOST = "127.0.0.1";

const root = fileURLToPath(new URL(".", import.meta.url));
const pagesDir = join(root, "pages");
const assetsDir = join(root, "assets");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webm": "video/webm",
};

export interface FixtureServer {
  /** e.g. http://127.0.0.1:47310 */
  pagesOrigin: string;
  /** e.g. http://127.0.0.1:47311 */
  assetsOrigin: string;
  /** The URL of a fixture page by name, e.g. pageUrl("plain-article"). */
  pageUrl(name: string): string;
  close(): Promise<void>;
}

/** The fixture page names (fixtures/pages/<name>.html). */
export function fixturePages(): string[] {
  return readdirSync(pagesDir)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -".html".length))
    .sort();
}

/** Resolves a URL path inside dir, or null when it escapes dir or names no file. */
function resolveInside(dir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const file = normalize(join(dir, decoded));
  if (file !== dir && !file.startsWith(dir + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
}

function pagesHandler(assetsOrigin: () => string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok\n");
      return;
    }
    if (path === "/") {
      const links = fixturePages()
        .map((p) => `<li><a href="/${p}.html">${p}</a></li>`)
        .join("\n");
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(`<!doctype html><meta charset="utf-8"><title>fixtures</title><ul>\n${links}\n</ul>\n`);
      return;
    }
    const file = resolveInside(pagesDir, path);
    if (file && extname(file) === ".svg") {
      // an SVG <use> takes its element from a same-origin file only: icon sprites are served here
      res.writeHead(200, { "content-type": MIME[".svg"], "cache-control": "no-store" });
      createReadStream(file).pipe(res);
      return;
    }
    if (!file || extname(file) !== ".html") return notFound(res);
    const html = readFileSync(file, "utf8")
      .replaceAll("{{ASSETS_LOCALHOST}}", assetsOrigin().replace(`//${HOST}:`, "//localhost:"))
      .replaceAll("{{ASSETS}}", assetsOrigin());
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(html);
  };
}

function assetsHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  const file = resolveInside(assetsDir, url.pathname);
  if (!file) return notFound(res);
  res.writeHead(200, {
    // ?type=<mime> declares another type, as a misconfigured server does (a PNG as text/html)
    "content-type": url.searchParams.get("type") || (MIME[extname(file)] ?? "application/octet-stream"),
    // fonts and fetch() need CORS across the two ports; images and sheets do not
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function startFixtureServer(
  opts: { pagesPort?: number; assetsPort?: number } = {},
): Promise<FixtureServer> {
  let assetsOrigin = "";
  const assets = createServer(assetsHandler);
  const pages = createServer(pagesHandler(() => assetsOrigin));
  const assetsPort = await listen(assets, opts.assetsPort ?? DEFAULT_ASSETS_PORT);
  assetsOrigin = `http://${HOST}:${assetsPort}`;
  let pagesPort: number;
  try {
    pagesPort = await listen(pages, opts.pagesPort ?? DEFAULT_PAGES_PORT);
  } catch (err) {
    await closeServer(assets);
    throw err;
  }
  const pagesOrigin = `http://${HOST}:${pagesPort}`;
  return {
    pagesOrigin,
    assetsOrigin,
    pageUrl: (name) => `${pagesOrigin}/${name}.html`,
    close: async () => {
      await Promise.all([closeServer(pages), closeServer(assets)]);
    },
  };
}

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name}=${raw} is not a port`);
  return port;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startFixtureServer({
    pagesPort: portFromEnv("PAGES_PORT", DEFAULT_PAGES_PORT),
    assetsPort: portFromEnv("ASSETS_PORT", DEFAULT_ASSETS_PORT),
  });
  console.log(`fixture pages  ${server.pagesOrigin}/`);
  console.log(`fixture assets ${server.assetsOrigin}/`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
