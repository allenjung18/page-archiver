// Records every response the page received while it loaded and settled, so the archive is built
// from the exact bytes the page used (its own cookies, no second fetch, no CORS). Status and MIME
// are noted as responses arrive; bodies are read lazily, when the archive asks for one.

export const MB = 1024 * 1024;
/** A single resource larger than this is never inlined. */
export const DEFAULT_RESOURCE_CAP = 25 * MB;
/** The recorder hands out at most this many body bytes in total. */
export const DEFAULT_TOTAL_CAP = 200 * MB;

/** The slice of a Playwright Response the recorder uses (a fake satisfies it in tests). */
export interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  request(): { redirectedFrom(): { url(): string; redirectedFrom(): unknown } | null };
}

/** The slice of a Playwright Page the recorder uses. */
export interface ResponseSource {
  on(event: "response", fn: (r: ResponseLike) => void): unknown;
  off(event: "response", fn: (r: ResponseLike) => void): unknown;
}

export type Lookup =
  | { kind: "hit"; url: string; status: number; mime: string; bytes: Buffer }
  | { kind: "miss"; url: string }
  /** Recorded, but unusable: an HTTP error, a cap, or a body Chromium no longer holds. */
  | { kind: "unusable"; url: string; reason: string; refetch: boolean };

interface Entry {
  status: number;
  mime: string;
  length: number | null;
  response: ResponseLike;
}

export interface RecorderOptions {
  resourceCap?: number | undefined;
  totalCap?: number | undefined;
}

export interface Recorder {
  /** The recorded response for url (fragment ignored, redirects followed). */
  get(url: string): Promise<Lookup>;
  /** Every recorded URL, in arrival order. */
  urls(): string[];
  /** Body bytes handed out so far. */
  bytesRead(): number;
  /** Stops recording. Lookups keep working while the page is open. */
  stop(): void;
}

/** The URL without its fragment: the key a response is stored under. */
export function resourceKey(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

export function createRecorder(page: ResponseSource, opts: RecorderOptions = {}): Recorder {
  const resourceCap = opts.resourceCap ?? DEFAULT_RESOURCE_CAP;
  const totalCap = opts.totalCap ?? DEFAULT_TOTAL_CAP;
  const entries = new Map<string, Entry>();
  const aliases = new Map<string, string>();
  let total = 0;

  const onResponse = (response: ResponseLike) => {
    const url = response.url();
    if (!/^https?:/i.test(url)) return;
    const status = response.status();
    if (status >= 300 && status < 400) return; // the redirect target arrives as its own response
    const headers = response.headers();
    const lengthHeader = headers["content-length"];
    const length = lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    const key = resourceKey(url);
    const previous = entries.get(key);
    // keep the newest success; never let an error replace a success
    if (previous && ok(previous.status) && !ok(status)) return;
    entries.set(key, { status, mime: headers["content-type"] ?? "", length, response });
    for (let r = response.request().redirectedFrom(); r; r = r.redirectedFrom() as typeof r) {
      aliases.set(resourceKey(r.url()), key);
    }
  };
  page.on("response", onResponse);

  return {
    async get(url) {
      let key = resourceKey(url);
      key = aliases.get(key) ?? key;
      const entry = entries.get(key);
      if (!entry) return { kind: "miss", url };
      if (!ok(entry.status)) return { kind: "unusable", url, reason: `HTTP ${entry.status}`, refetch: false };
      if (entry.length !== null && entry.length > resourceCap) {
        return { kind: "unusable", url, reason: `over the ${mb(resourceCap)} per-resource cap (${mb(entry.length)})`, refetch: false };
      }
      let bytes: Buffer;
      try {
        bytes = await entry.response.body();
      } catch (err) {
        return { kind: "unusable", url, reason: `body unavailable: ${(err as Error).message.split("\n")[0]}`, refetch: true };
      }
      if (bytes.byteLength > resourceCap) {
        return { kind: "unusable", url, reason: `over the ${mb(resourceCap)} per-resource cap (${mb(bytes.byteLength)})`, refetch: false };
      }
      if (total + bytes.byteLength > totalCap) {
        return { kind: "unusable", url, reason: `over the ${mb(totalCap)} total cap`, refetch: false };
      }
      total += bytes.byteLength;
      return { kind: "hit", url, status: entry.status, mime: entry.mime, bytes };
    },
    urls: () => [...entries.keys()],
    bytesRead: () => total,
    stop: () => void page.off("response", onResponse),
  };
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function mb(n: number): string {
  return `${(n / MB).toFixed(n < MB ? 2 : 0)} MB`;
}
