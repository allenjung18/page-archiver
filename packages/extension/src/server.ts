// The extension's side of `pa serve`. Writes need the server's token. The extension pairs by
// reading it from the reader UI's page (`<meta name="pa-token">`), which only a client allowed
// to read 127.0.0.1 cross-origin can do (this extension, by its host permission; no web page),
// and keeps it; a token refused (the server restarted with a new one) is read again, once.
import { SERVER_KEY, TOKEN_KEY } from "./protocol.ts";
import type { StorageArea } from "./chrome.ts";

/** Where `pa serve` listens unless told otherwise (server's DEFAULT_HOST and DEFAULT_PORT). */
export const DEFAULT_SERVER = "http://127.0.0.1:47320/";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CaptureUpload {
  url: string;
  html: string;
  tags: string[];
}

export type Delivery =
  | { kind: "saved"; pageId: string; libraryUrl: string; warnings: string[] }
  /** The server could not be reached, or did not answer in time (it may still have saved it). */
  | { kind: "unreachable"; reason: string }
  /** The server answered and did not save it. */
  | { kind: "refused"; reason: string };

/** The server's base URL from settings, normalized to end in `/`; the default when unset or bad. */
export async function serverUrl(store: StorageArea): Promise<string> {
  const v = (await store.get(SERVER_KEY))[SERVER_KEY];
  return normalizeServer(typeof v === "string" ? v : "") ?? DEFAULT_SERVER;
}

/** An http(s) URL's origin with a trailing slash, or null. */
export function normalizeServer(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

/** The token written into the reader UI's page, or null. */
export function tokenFromPage(html: string): string | null {
  return /<meta name="pa-token" content="([0-9a-f]{32,})">/.exec(html)?.[1] ?? null;
}

/** How long the server gets to answer one request (an import of a large page can be slow). */
export const ANSWER_TIMEOUT_MS = 120_000;

class Unreachable extends Error {
  /** It connected and did not answer in time: the server may have saved it all the same. */
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(message);
    this.timedOut = timedOut;
  }
}

async function call(fetchFn: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    throw new Unreachable(`${url}: ${(err as Error).message}`, timedOut);
  }
}

async function pair(fetchFn: Fetch, server: string, store: StorageArea): Promise<string> {
  const res = await call(fetchFn, server, { method: "GET" });
  const token = res.ok ? tokenFromPage(await res.text()) : null;
  if (!token) throw new Error(`could not pair with ${server}: its page gave no token (HTTP ${res.status})`);
  await store.set({ [TOKEN_KEY]: token });
  return token;
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return `HTTP ${res.status}: ${body.error}`;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

/** Sends a finished archive to the library: pairs first when there is no token yet. */
export async function deliver(fetchFn: Fetch, store: StorageArea, upload: CaptureUpload): Promise<Delivery> {
  const server = await serverUrl(store);
  try {
    const stored = (await store.get(TOKEN_KEY))[TOKEN_KEY];
    let token = typeof stored === "string" && stored ? stored : await pair(fetchFn, server, store);
    const post = (t: string) =>
      call(fetchFn, new URL("api/save", server).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify(upload),
      });
    let res = await post(token);
    if (res.status === 401) {
      token = await pair(fetchFn, server, store);
      res = await post(token);
    }
    if (!res.ok) return { kind: "refused", reason: await errorOf(res) };
    const body = (await res.json()) as { page: { id: string }; warnings?: string[] };
    return { kind: "saved", pageId: body.page.id, libraryUrl: server, warnings: body.warnings ?? [] };
  } catch (err) {
    if (err instanceof Unreachable) {
      const reason = err.timedOut
        ? `the library server did not answer in ${ANSWER_TIMEOUT_MS / 1000} s, so it may have saved the page as well (${err.message})`
        : `the library server is not running (${err.message})`;
      return { kind: "unreachable", reason };
    }
    return { kind: "refused", reason: (err as Error).message };
  }
}
