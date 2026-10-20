// Local HTTP API and reader UI, bound to 127.0.0.1 and nothing else, serving archives under
// ARCHIVE_CSP. startServer() opens the library, picks a random write token and listens.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { openLibrary, type Library } from "@page-archiver/library";
import { createApp } from "./api.ts";

export { ARCHIVE_CSP } from "@page-archiver/core";
export { createApp, DEFAULT_UI_DIR, segments, UI_CSP, type AppOptions, type Hit, type Segment } from "./api.ts";
export { ARCHIVE_HEADERS, archiveResponse, isView, VIEWS, type View } from "./serve-archive.ts";

/** The only address the server listens on. */
export const DEFAULT_HOST = "127.0.0.1";
/** The port `pa serve` takes unless told otherwise. */
export const DEFAULT_PORT = 47320;

export interface ServeOptions {
  /** The library's root folder (opened and closed by the server), or an open library (left open). */
  library: string | Library;
  /** 0: any free port. Default DEFAULT_PORT. */
  port?: number | undefined;
  /** Default: 24 random bytes as hex. */
  token?: string | undefined;
  uiDir?: string | undefined;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  library: Library;
  close(): Promise<void>;
}

/** A fresh write token: 48 hex characters. */
export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const owned = typeof opts.library === "string";
  const token = opts.token ?? newToken();
  if (!/^[0-9a-f]{32,}$/.test(token)) throw new Error("the token must be at least 32 hex characters");
  const library = typeof opts.library === "string" ? openLibrary(opts.library) : opts.library;
  const hosts = new Set<string>();
  const app = createApp({ library, token, hosts, uiDir: opts.uiDir });
  const want = opts.port ?? DEFAULT_PORT;
  let server: ServerType | undefined;
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: DEFAULT_HOST, port: want }, (info: AddressInfo) => resolve(info.port));
      server.once("error", reject);
    });
  } catch (err) {
    if (owned) library.close();
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`port ${want} is in use: pass another with --port`);
    throw err;
  }
  const listening = server!;
  hosts.add(`${DEFAULT_HOST}:${port}`);
  hosts.add(`localhost:${port}`);
  return {
    url: `http://${DEFAULT_HOST}:${port}/`,
    port,
    token,
    library,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listening.close((err) => {
          if (owned) library.close();
          if (err) reject(err);
          else resolve();
        });
        // keep-alive connections from a browser would hold close() open
        if ("closeAllConnections" in listening) listening.closeAllConnections();
      }),
  };
}
