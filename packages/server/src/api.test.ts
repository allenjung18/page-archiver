import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importHtml } from "@page-archiver/core";
import { openLibrary, type Library, type PageRecord } from "@page-archiver/library";
import { createApp, segments, UI_CSP, type Hit } from "./api.ts";
import { startServer } from "./index.ts";

/** Written out in full on purpose: the header must be these bytes, not whatever the constant says. */
const EXACT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; frame-src data: about:";
const TOKEN = "0123456789abcdef0123456789abcdef";
const HOST = "127.0.0.1:47999";
const ORIGIN = `http://${HOST}`;

function save(opts: { url: string; title: string; body: string; savedAt: string }): string {
  return `<!DOCTYPE html><html lang="en"><!--
 Page saved with SingleFile
 url: ${opts.url}
 saved date: ${opts.savedAt}
--><head><meta charset="utf-8"><title>${opts.title}</title></head>
<body><article><h1>${opts.title}</h1><p>${opts.body}</p><p>The rest of the article is ordinary prose about the weather, the tides and the harbour, long enough that a reader view finds it worth keeping as the main text.</p></article></body></html>`;
}

const ARTICLES = [
  { url: "https://gazette.example/tides", title: "Tides of the Inner Basin", body: "The basin floods twice a day and the quayside cafés move their chairs.", savedAt: "2026-03-12T10:00:00Z" },
  { url: "https://blog.example/kelp", title: "Kelp in Winter", body: "Holdfasts grip the rock; the zanzibarite shelf is where the urchins gather.", savedAt: "2026-05-01T08:30:00Z" },
];

let tmp: string;
let lib: Library;
let app: ReturnType<typeof createApp>;
let uiDir: string;
const captured: string[] = [];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "pa-server-"));
  lib = openLibrary(join(tmp, "lib"), {
    // a stand-in for Chromium: the capture is the second article's save, at the URL asked for
    capture: async (url, opts) => {
      captured.push(url);
      return importHtml(save({ ...ARTICLES[1]!, body: "The zanzibarite shelf, captured again.", savedAt: "2026-10-01T00:00:00Z" }), { url, versionOf: opts?.versionOf, tags: opts?.tags });
    },
  });
  for (const [i, a] of ARTICLES.entries()) {
    const f = join(tmp, `a${i}.html`);
    writeFileSync(f, save(a));
    await lib.importFile(f, { tags: i === 0 ? ["sea", "news"] : ["sea"] });
  }
  uiDir = join(tmp, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), '<!doctype html><head><meta name="pa-token" content=""><script type="module" src="/assets/app.js"></script></head>');
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log('ui');");
  writeFileSync(join(tmp, "secret.js"), "secret");
  captured.length = 0;
  app = createApp({ library: lib, token: TOKEN, hosts: new Set([HOST]), uiDir });
});

afterEach(() => {
  lib.close();
  rmSync(tmp, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init);
const write = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  app.request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const tides = () => lib.list().find((p) => p.title.startsWith("Tides"))!;

describe("reading the library", () => {
  it("lists pages with the library's filters", async () => {
    expect(((await (await get("/api/pages")).json()) as PageRecord[]).map((p) => p.title)).toEqual(["Kelp in Winter", "Tides of the Inner Basin"]);
    expect(((await (await get("/api/pages?tag=news")).json()) as PageRecord[]).map((p) => p.title)).toEqual(["Tides of the Inner Basin"]);
    expect(((await (await get("/api/pages?since=2026-04-01")).json()) as PageRecord[]).map((p) => p.title)).toEqual(["Kelp in Winter"]);
    expect(((await (await get("/api/pages?site=gazette.example")).json()) as PageRecord[]).map((p) => p.title)).toEqual(["Tides of the Inner Basin"]);
    expect((await get("/api/pages?since=yesterday")).status).toBe(400);
    expect((await get("/api/pages?limit=0")).status).toBe(400);
  });

  it("searches, with the snippet's hits as marked segments", async () => {
    const hits = (await (await get("/api/search?q=zanzibarite")).json()) as Hit[];
    expect(hits.map((h) => h.title)).toEqual(["Kelp in Winter"]);
    expect(hits[0]!.snippet.filter((s) => s.hit).map((s) => s.text)).toEqual(["zanzibarite"]);
    expect(hits[0]!.snippet.map((s) => s.text).join("")).toContain("the zanzibarite shelf");
    expect((await (await get("/api/search?q=zanzibarite&tag=news")).json()) as Hit[]).toEqual([]);
    expect((await get("/api/search?q=")).status).toBe(400);
  });

  it("names the sites and tags to filter by", async () => {
    expect(await (await get("/api/facets")).json()).toEqual({
      sites: [
        { name: "blog.example", count: 1 },
        { name: "gazette.example", count: 1 },
      ],
      tags: [
        { name: "sea", count: 2 },
        { name: "news", count: 1 },
      ],
    });
  });

  it("returns one page and its versions; an unknown id is a 404", async () => {
    const p = tides();
    const res = (await (await get(`/api/pages/${p.id}`)).json()) as { page: PageRecord; versions: unknown[] };
    expect(res.page.id).toBe(p.id);
    expect(res.versions).toHaveLength(1);
    expect((await get("/api/pages/zzzzzzzzzzzz")).status).toBe(404);
    expect((await get("/api/pages/..")).status).toBe(404);
  });
});

describe("the archive route", () => {
  it("serves the archive and the reader copy under exactly the archive CSP", async () => {
    const p = tides();
    for (const [view, file] of [["original", "archive.html"], ["reader", "reader.html"]] as const) {
      const res = await get(`/archive/${p.id}/${view}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(EXACT_CSP);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(readFileSync(lib.pathOf(p, file), "utf8"));
    }
    const head = await get(`/archive/${p.id}/original`, { method: "HEAD" });
    expect(head.headers.get("content-security-policy")).toBe(EXACT_CSP);
    expect(await head.text()).toBe("");
  });

  it("serves nothing else from the folder, and 404s what is not there", async () => {
    const p = tides();
    expect((await get(`/archive/${p.id}/meta.json`)).status).toBe(404);
    expect((await get(`/archive/${p.id}/..%2fmeta.json`)).status).toBe(404);
    expect((await get("/archive/zzzzzzzzzzzz/original")).status).toBe(404);
    rmSync(lib.pathOf(p, "reader.html"));
    expect((await get(`/archive/${p.id}/reader`)).status).toBe(404);
  });
});

describe("writes", () => {
  it("need the token", async () => {
    const p = tides();
    for (const token of [null, "", "wrong", TOKEN.slice(0, -1), `${TOKEN}0`]) {
      expect((await write("DELETE", `/api/pages/${p.id}`, undefined, token)).status, String(token)).toBe(401);
      expect((await write("POST", `/api/pages/${p.id}/tags`, { add: ["x"] }, token)).status).toBe(401);
      expect((await write("POST", `/api/pages/${p.id}/recapture`, undefined, token)).status).toBe(401);
      expect((await write("POST", "/api/save", { url: "https://a.example/" }, token)).status).toBe(401);
    }
    expect(lib.get(p.id).tags).toEqual(["sea", "news"]);
    expect(captured).toEqual([]);
  });

  it("delete removes the capture's folder and its index entry", async () => {
    const p = tides();
    const folder = lib.pathOf(p, "");
    const res = await write("DELETE", `/api/pages/${p.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: p.id });
    expect(existsSync(folder)).toBe(false);
    expect(lib.list().map((x) => x.title)).toEqual(["Kelp in Winter"]);
    expect((await write("DELETE", `/api/pages/${p.id}`)).status).toBe(404);
  });

  it("tags adds and removes, and checks its body", async () => {
    const p = tides();
    const res = await write("POST", `/api/pages/${p.id}/tags`, { add: ["harbour"], remove: ["news"] });
    expect(((await res.json()) as PageRecord).tags).toEqual(["sea", "harbour"]);
    expect((await write("POST", `/api/pages/${p.id}/tags`, { add: "x" })).status).toBe(400);
    expect((await write("POST", `/api/pages/${p.id}/tags`, [])).status).toBe(400);
  });

  it("re-capture saves the page's URL again as its next version", async () => {
    const kelp = lib.search("zanzibarite")[0]!;
    const res = await write("POST", `/api/pages/${kelp.id}/recapture`);
    expect(res.status).toBe(201);
    const { page } = (await res.json()) as { page: PageRecord };
    expect(captured).toEqual([kelp.url]);
    expect(page).toMatchObject({ url: kelp.url, version: 2, versions: 2, versionOf: kelp.id, tags: ["sea"] });
  });

  it("save captures an http(s) URL and refuses anything else", async () => {
    const res = await write("POST", "/api/save", { url: "https://new.example/page", tags: ["new"] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { page: PageRecord }).page).toMatchObject({ url: "https://new.example/page", version: 1, tags: ["new"] });
    for (const body of [{ url: "file:///etc/passwd" }, { url: "javascript:alert(1)" }, { url: 3 }, {}, { url: "https://a.example/", tags: "x" }]) {
      expect((await write("POST", "/api/save", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(captured).toEqual(["https://new.example/page"]);
  });
});

describe("the host check", () => {
  it("refuses a request naming another host (a DNS name rebound to 127.0.0.1)", async () => {
    expect((await app.request("http://evil.example:47999/api/pages")).status).toBe(403);
    expect((await app.request("http://127.0.0.1:1/api/pages")).status).toBe(403);
    expect((await app.request(`${ORIGIN}/api/pages`, { headers: { host: "evil.example:47999" } })).status).toBe(403);
  });
});

describe("the UI", () => {
  it("writes the token into the page and serves it under its own CSP", async () => {
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(UI_CSP).not.toMatch(/unsafe/);
    expect(await res.text()).toContain(`<meta name="pa-token" content="${TOKEN}">`);
    const js = await get("/assets/app.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("console.log('ui');");
    expect((await get("/assets/..%2f..%2fsecret.js")).status).toBe(404);
    expect((await get("/assets/missing.js")).status).toBe(404);
  });

  it("says when the UI is not built", async () => {
    const bare = createApp({ library: lib, token: TOKEN, hosts: new Set([HOST]), uiDir: join(tmp, "nowhere") });
    expect((await bare.request(`${ORIGIN}/`)).status).toBe(503);
  });
});

describe("segments", () => {
  it("splits a marked snippet into plain and hit runs", () => {
    expect(segments("a b c d")).toEqual([
      { text: "a ", hit: false },
      { text: "b", hit: true },
      { text: " c ", hit: false },
      { text: "d", hit: true },
    ]);
    expect(segments("xy")).toEqual([
      { text: "x", hit: true },
      { text: "y", hit: true },
    ]);
  });
});

describe("startServer", () => {
  it("listens on 127.0.0.1 only, answers its own host, refuses another, and closes", async () => {
    const server = await startServer({ library: lib, port: 0, uiDir });
    try {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
      expect(server.token).toMatch(/^[0-9a-f]{48}$/);
      const res = await fetch(`${server.url}api/pages`);
      expect(res.status).toBe(200);
      const status = (host: string) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port: server.port, path: "/api/pages", headers: { host } }, (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await status(`localhost:${server.port}`)).toBe(200);
      expect(await status(`rebound.example:${server.port}`)).toBe(403);
    } finally {
      await server.close();
    }
    await expect(fetch(`${server.url}api/pages`)).rejects.toThrow();
    // a library it was handed stays open
    expect(lib.list()).toHaveLength(2);
  });
});
