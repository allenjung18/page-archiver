import { describe, expect, it } from "vitest";
import type { Snapshot } from "@page-archiver/serializer";
import { verifyStamp } from "@page-archiver/core/portable";
import { readStamp } from "@page-archiver/core";
import type { ContentApi, FrameReport } from "./protocol.ts";
import { downloadName, saveTab, type Env } from "./save.ts";
import type { Fetch } from "./server.ts";
import { memoryStore } from "./testing.ts";

const PAGE = "https://site.test/article";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TOKEN = "c".repeat(48);

const snap: Snapshot = {
  html: `<!doctype html><html><head><title>Article</title><link rel="stylesheet" href="/s.css"></head><body><img src="https://cdn.test/i.png"><p>Hello</p><script>steal()</script></body></html>`,
  baseUrl: PAGE,
  url: PAGE,
  title: "Article",
  manifest: [],
  fonts: [],
  warnings: [],
};

/** A tab with one frame whose content script answers with `snap`. */
function env(opts: { serverUp: boolean; url?: string; html?: string; responses?: Record<string, (init?: RequestInit) => Response> }) {
  const api: ContentApi = {
    mark: () => [],
    frameId: () => null,
    snapshot: async (): Promise<FrameReport> => ({ snap: opts.html ? { ...snap, html: opts.html } : snap, id: null, loaded: [] }),
    unmark: () => undefined,
  };
  const g = globalThis as { __pageArchiver?: ContentApi };
  const fetched: string[] = [];
  const credentials: Record<string, RequestCredentials | undefined> = {};
  const calls: Array<{ url: string; credentials?: RequestCredentials | undefined; redirect?: RequestRedirect | undefined }> = [];
  const posted: Array<{ url: string; html: string; tags: string[] }> = [];
  const downloads: Array<{ url: string; filename: string }> = [];
  const fetchFn: Fetch = async (url, init) => {
    if (url.startsWith("http://127.0.0.1:47320/") && init?.method) {
      if (!opts.serverUp) throw new TypeError("Failed to fetch");
      if (init?.method === "GET") return new Response(`<meta name="pa-token" content="${TOKEN}">`);
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ page: { id: "pid000000001" }, warnings: [] }, { status: 201 });
    }
    fetched.push(url);
    credentials[url] = init?.credentials;
    calls.push({ url, credentials: init?.credentials, redirect: init?.redirect });
    const made = opts.responses?.[url];
    if (made) return made(init);
    if (url === "https://site.test/s.css") return new Response("body { background: url(bg.png) }", { headers: { "content-type": "text/css" } });
    if (url === "https://site.test/bg.png" || url === "https://cdn.test/i.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (url.startsWith("http://127.0.0.1:47320/")) return new Response(`<meta name="pa-token" content="${TOKEN}">`, { headers: { "content-type": "image/png" } });
    if (/^http:\/\/(192\.168\.|10\.|169\.254\.|\[::1\])/.test(url)) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return new Response("", { status: 404 });
  };
  const e: Env = {
    tabs: { get: async () => ({ id: 4, url: opts.url ?? PAGE, title: "Tab title" }), query: async () => [], create: async () => ({}) },
    scripting: {
      executeScript: (async (d: { func?: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        if (!d.func) return [];
        g.__pageArchiver = api;
        try {
          return [{ frameId: 0, result: await d.func(...(d.args ?? [])) }];
        } finally {
          delete g.__pageArchiver;
        }
      }) as Env["scripting"]["executeScript"],
    },
    storage: { local: memoryStore(), session: memoryStore() },
    downloads: { download: async (o) => (downloads.push(o), 17) },
    fetch: fetchFn,
    now: () => new Date("2026-10-20T08:00:00.123Z"),
    frameWaitMs: 0,
  };
  return { env: e, fetched, credentials, calls, posted, downloads };
}

function checkArchive(html: string) {
  expect(html).not.toMatch(/<script|https:\/\/cdn\.test|url\(bg\.png\)/);
  expect(html).toContain("data:image/png;base64,");
  expect(verifyStamp(html)).toBe(true);
  expect(readStamp(html)).toMatchObject({ "source-url": PAGE, "captured-at": "2026-10-20T08:00:00.123Z" });
}

describe("saveTab", () => {
  it("fetches every resource in the service worker, nested CSS ones too, and posts the finished archive", async () => {
    const t = env({ serverUp: true });
    const result = await saveTab(t.env, 4, ["a", "b"]);
    expect(result).toEqual({ kind: "saved", url: PAGE, title: "Article", pageId: "pid000000001", libraryUrl: "http://127.0.0.1:47320/", warnings: [] });
    expect(t.fetched.sort()).toEqual(["https://cdn.test/i.png", "https://site.test/bg.png", "https://site.test/s.css"]);
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]).toMatchObject({ url: PAGE, tags: ["a", "b"] });
    checkArchive(t.posted[0]!.html);
    expect(t.downloads).toEqual([]);
    expect(t.credentials, "the reader's cookies go to the page's own site only").toEqual({
      "https://site.test/s.css": "include",
      "https://site.test/bg.png": "include",
      "https://cdn.test/i.png": "omit",
    });
  });

  it("sets aside, unfetched, resources on loopback, private-network and link-local hosts that are not the page's own", async () => {
    const refused = ["http://127.0.0.1:47320/t.png", "http://192.168.0.1/x.png", "http://10.0.0.8/y.png", "http://169.254.169.254/latest/meta-data/", "http://[::1]/a.png"];
    const html = `<!doctype html><html><head><title>Article</title></head><body>${refused.map((u) => `<img src="${u}">`).join("")}<img src="https://cdn.test/i.png"></body></html>`;
    const t = env({ serverUp: false, html });
    const result = await saveTab(t.env, 4, []);
    expect(result.kind).toBe("downloaded");
    expect(t.fetched, "only the public image is fetched").toEqual(["https://cdn.test/i.png"]);
    const warnings = result.kind === "downloaded" ? result.warnings : [];
    for (const u of refused) expect(warnings, u).toContainEqual(expect.stringMatching(new RegExp(`^${u.replace(/[.[\]/]/g, "\\$&")}: .*refused: an? (loopback|private network|link-local) address.*; set aside$`)));
    const archive = Buffer.from(t.downloads[0]!.url.split(",")[1]!, "base64").toString("utf8");
    expect(archive, "the server's token is not in the archive").not.toContain(TOKEN);
    for (const u of refused) expect(archive).toContain(`data-page-archiver-unfetched-src="${u}"`);
  });

  it("follows a redirect only without the reader's cookies", async () => {
    // a same-site image that redirects (to another site): the fetch with cookies does not follow it
    const moved = (init?: RequestInit) => {
      if (init?.redirect === "manual") {
        const res = new Response(null, { status: 200 });
        Object.defineProperty(res, "type", { value: "opaqueredirect" });
        Object.defineProperty(res, "status", { value: 0 });
        return res;
      }
      const res = new Response(PNG, { headers: { "content-type": "image/png" } });
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", { value: "https://other.test/signed.png" });
      return res;
    };
    const html = `<!doctype html><html><head><title>Article</title></head><body><img src="https://site.test/moved.png"><img src="https://site.test/bg.png"></body></html>`;
    const t = env({ serverUp: false, html, responses: { "https://site.test/moved.png": moved } });
    const result = await saveTab(t.env, 4, []);
    expect(result.kind === "downloaded" ? result.warnings : null).toEqual([]);
    expect(t.calls.filter((c) => c.url === "https://site.test/moved.png")).toEqual([
      { url: "https://site.test/moved.png", credentials: "include", redirect: "manual" },
      { url: "https://site.test/moved.png", credentials: "omit", redirect: "follow" },
    ]);
    expect(t.calls.filter((c) => c.url === "https://site.test/bg.png"), "a same-site resource that does not redirect keeps its cookies").toEqual([
      { url: "https://site.test/bg.png", credentials: "include", redirect: "manual" },
    ]);
    const archive = Buffer.from(t.downloads[0]!.url.split(",")[1]!, "base64").toString("utf8");
    expect(archive).not.toContain("site.test/moved.png");
  });

  it("sets aside a public resource that redirects to a loopback address", async () => {
    const redirected = () => {
      const res = new Response(`<meta name="pa-token" content="${TOKEN}">`, { headers: { "content-type": "image/png" } });
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", { value: "http://127.0.0.1:47320/" });
      return res;
    };
    const html = `<!doctype html><html><head><title>Article</title></head><body><img src="https://evil.test/r.png"></body></html>`;
    const t = env({ serverUp: false, html, responses: { "https://evil.test/r.png": redirected } });
    const result = await saveTab(t.env, 4, []);
    const warnings = result.kind === "downloaded" ? result.warnings : [];
    expect(warnings).toContainEqual(expect.stringMatching(/^https:\/\/evil\.test\/r\.png: .*redirected to http:\/\/127\.0\.0\.1:47320\/.*a loopback address.*; set aside$/));
    const archive = Buffer.from(t.downloads[0]!.url.split(",")[1]!, "base64").toString("utf8");
    expect(archive).not.toContain(TOKEN);
    expect(archive).not.toContain(Buffer.from(`<meta name="pa-token"`).toString("base64").slice(0, 16));
  });

  it("downloads archive.html when the server is not running", async () => {
    const t = env({ serverUp: false });
    const result = await saveTab(t.env, 4, []);
    expect(result).toMatchObject({ kind: "downloaded", downloadId: 17, filename: "page-archiver/site-test-article-2026-10-20T08-00-00Z.html", reason: expect.stringMatching(/not running/) });
    expect(t.downloads).toHaveLength(1);
    const prefix = "data:text/html;charset=utf-8;base64,";
    expect(t.downloads[0]!.url.startsWith(prefix)).toBe(true);
    checkArchive(Buffer.from(t.downloads[0]!.url.slice(prefix.length), "base64").toString("utf8"));
  });

  it("neither posts nor downloads a save that was given up", async () => {
    for (const serverUp of [true, false]) {
      const t = env({ serverUp });
      const abort = new AbortController();
      abort.abort();
      const result = await saveTab({ ...t.env, signal: abort.signal }, 4, []);
      expect(result, `server up: ${serverUp}`).toMatchObject({ kind: "failed", url: PAGE });
      expect(t.posted).toEqual([]);
      expect(t.downloads).toEqual([]);
    }
  });

  it("refuses a page that is not http(s) without touching it", async () => {
    const t = env({ serverUp: true, url: "chrome://settings/" });
    expect(await saveTab(t.env, 4, [])).toEqual({ kind: "failed", url: "chrome://settings/", error: "only http and https pages can be saved" });
    expect(t.fetched).toEqual([]);
  });
});

describe("downloadName", () => {
  it("names the file by host, title and time, in a folder of its own", () => {
    expect(downloadName("https://news.example.com/x", "Ünïcode: a/b \\ c?", new Date("2026-01-02T03:04:05.678Z"))).toBe("page-archiver/news-example-com-unicode-a-b-c-2026-01-02T03-04-05Z.html");
    expect(downloadName("not a url", "", new Date("2026-01-02T03:04:05Z"))).toBe("page-archiver/page-2026-01-02T03-04-05Z.html");
  });
});
