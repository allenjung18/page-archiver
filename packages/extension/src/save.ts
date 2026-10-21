// Saving a tab: snapshot every frame in the tab (content.ts), fetch every resource the snapshots
// name from the service worker (host permission for every site, so no CORS; the reader's cookies
// go only to the page's own site, and no private-network host but the page's own is fetched, see
// hosts.ts), assemble the archive with core's own assemble(), then hand it
// to the library server; when the server is not running or will not take it, download
// archive.html instead so the capture is never lost.
import { assemble, base64, createResolver, DEFAULT_RESOURCE_CAP, DEFAULT_TOTAL_CAP, MAX_FRAME_DEPTH } from "@page-archiver/core/portable";
import type { Chrome, InjectionResult } from "./chrome.ts";
import { credentialsFor, refusal } from "./hosts.ts";
import type { ContentApi, FrameReport, MarkedFrame, SaveResult } from "./protocol.ts";
import { deliver, serverUrl, type Fetch } from "./server.ts";
import { buildTree } from "./tree.ts";

/** Injected into every frame, in this order (both are in the extension's own folder). */
export const CONTENT_FILES = ["serializer.iife.js", "content.js"];

export type Env = Pick<Chrome, "tabs" | "scripting" | "storage" | "downloads"> & {
  fetch: Fetch;
  now?: () => Date;
  /** How long to wait for child frames to learn their ids. Default 2 s. */
  frameWaitMs?: number;
};

type Api = { __pageArchiver?: ContentApi };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The page a resource is fetched for, and the library server's address (both shape the fetch, hosts.ts). */
export interface FetchFor {
  pageUrl: string;
  server?: string;
}

/**
 * A resource's bytes from the service worker, with the reader's cookies when it is on the page's
 * own site. A target `refusal` names (a private-network host not the page's own, the library
 * server), before the fetch or after a redirect, throws: the resolver sets it aside with a warning.
 * A redirect is followed only without cookies (where it leads is not known until it is followed,
 * and the cookies would go with every hop): a fetch with cookies does not follow one, and on a
 * redirect the resource is fetched again without them.
 */
export async function fetchResource(fetchFn: Fetch, url: string, page: FetchFor): Promise<{ status: number; mime: string; bytes: Uint8Array }> {
  const why = refusal(url, page.pageUrl, page.server);
  if (why) throw new Error(`refused: ${why}`);
  const init = { cache: "force-cache", signal: AbortSignal.timeout(30_000) } as const;
  const credentials = credentialsFor(url, page.pageUrl);
  let res = await fetchFn(url, { ...init, credentials, redirect: credentials === "include" ? "manual" : "follow" });
  if (res.type === "opaqueredirect") res = await fetchFn(url, { ...init, credentials: "omit", redirect: "follow" });
  const after = res.redirected && res.url ? refusal(res.url, page.pageUrl, page.server) : null;
  if (after) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`refused: redirected to ${res.url}, ${after}`);
  }
  return { status: res.status, mime: res.headers.get("content-type") ?? "", bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** A file name for a downloaded archive: page-archiver/<host>-<title words>-<time>.html. */
export function downloadName(url: string, title: string, at: Date): string {
  let host = "page";
  try {
    host = new URL(url).hostname || host;
  } catch {
    // keep "page"
  }
  const words = `${host} ${title}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replace(/[:]/g, "-");
  return `page-archiver/${words || "page"}-${stamp}.html`;
}

/** Snapshots every frame of the tab, and the frame tree they make. */
export async function snapshotTab(env: Env, tabId: number) {
  const target = { tabId, allFrames: true };
  await env.scripting.executeScript({ target, files: CONTENT_FILES });
  const nonce = crypto.randomUUID();
  const marks: InjectionResult<MarkedFrame[]>[] = await env.scripting.executeScript({
    target,
    func: (n: string) => (globalThis as Api).__pageArchiver?.mark(n) ?? [],
    args: [nonce],
  });
  try {
    const marked = marks.flatMap((r) => r.result ?? []);
    // each child frame hears its id by postMessage; wait until every frame reached has it
    const deadline = Date.now() + (env.frameWaitMs ?? 2000);
    for (;;) {
      const ids = await env.scripting.executeScript({ target, func: (n: string) => (globalThis as Api).__pageArchiver?.frameId(n) ?? null, args: [nonce] });
      const waiting = ids.filter((r) => r.frameId !== 0 && !r.result).length;
      if (!waiting || Date.now() >= deadline) break;
      await sleep(50);
    }
    const snaps: InjectionResult<FrameReport | null>[] = await env.scripting.executeScript({
      target,
      func: (n: string) => (globalThis as Api).__pageArchiver?.snapshot(n) ?? null,
      args: [nonce],
    });
    return buildTree({ reports: snaps.map((r) => ({ frameId: r.frameId, report: r.result })), marked, maxDepth: MAX_FRAME_DEPTH });
  } finally {
    await env.scripting.executeScript({ target, func: () => (globalThis as Api).__pageArchiver?.unmark() }).catch(() => undefined);
  }
}

/** Saves the tab into the library, or downloads its archive when the library cannot take it. */
export async function saveTab(env: Env, tabId: number, tags: readonly string[]): Promise<SaveResult> {
  const tab = await env.tabs.get(tabId);
  const url = tab.url ?? "";
  if (!/^https?:\/\//i.test(url)) return { kind: "failed", url, error: "only http and https pages can be saved" };
  try {
    const capturedAt = (env.now ?? (() => new Date()))();
    const { tree, loaded, warnings } = await snapshotTab(env, tabId);
    const server = await serverUrl(env.storage.local);
    const resolver = createResolver({
      recorder: { get: async (u: string) => ({ kind: "miss" as const, url: u }) },
      fallback: (u) => fetchResource(env.fetch, u, { pageUrl: url, server }),
      resourceCap: DEFAULT_RESOURCE_CAP,
      totalCap: DEFAULT_TOTAL_CAP,
    });
    const archive = await assemble({ tree, sourceUrl: url, capturedAt, resolver, fetched: (u) => loaded.has(u), warnings });
    const title = tree.snap.title.trim() || tab.title || url;

    const sent = await deliver(env.fetch, env.storage.local, { url, html: archive.html, tags: [...tags] });
    if (sent.kind === "saved") return { kind: "saved", url, title, pageId: sent.pageId, libraryUrl: sent.libraryUrl, warnings: sent.warnings };

    const filename = downloadName(url, title, capturedAt);
    const dataUrl = `data:text/html;charset=utf-8;base64,${base64(new TextEncoder().encode(archive.html))}`;
    const downloadId = await env.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify", saveAs: false });
    return { kind: "downloaded", url, title, filename, downloadId, reason: sent.reason, warnings: archive.warnings };
  } catch (err) {
    return { kind: "failed", url, error: (err as Error).message.split("\n")[0] ?? String(err) };
  }
}
