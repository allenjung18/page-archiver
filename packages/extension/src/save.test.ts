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
function env(opts: { serverUp: boolean; url?: string }) {
  const api: ContentApi = {
    mark: () => [],
    frameId: () => null,
    snapshot: async (): Promise<FrameReport> => ({ snap, id: null, loaded: [] }),
    unmark: () => undefined,
  };
  const g = globalThis as { __pageArchiver?: ContentApi };
  const fetched: string[] = [];
  const posted: Array<{ url: string; html: string; tags: string[] }> = [];
  const downloads: Array<{ url: string; filename: string }> = [];
  const fetchFn: Fetch = async (url, init) => {
    if (url.startsWith("http://127.0.0.1:47320/")) {
      if (!opts.serverUp) throw new TypeError("Failed to fetch");
      if (init?.method === "GET") return new Response(`<meta name="pa-token" content="${TOKEN}">`);
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ page: { id: "pid000000001" }, warnings: [] }, { status: 201 });
    }
    fetched.push(url);
    expect(init?.credentials, "resource fetches carry the reader's cookies").toBe("include");
    if (url === "https://site.test/s.css") return new Response("body { background: url(bg.png) }", { headers: { "content-type": "text/css" } });
    if (url === "https://site.test/bg.png" || url === "https://cdn.test/i.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
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
  return { env: e, fetched, posted, downloads };
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
