import { describe, expect, it } from "vitest";
import type { Snapshot } from "@page-archiver/serializer";
import { buildFrame, fetchForPage, type BuildContext } from "./capture.ts";
import { serializeDocument } from "./dom.ts";
import { FRAME_ATTRIBUTE, type FrameCapture } from "./frames.ts";
import type { Resolver } from "./resources.ts";

function node(html: string, url: string, depth: number, children: Array<[string, FrameCapture | null]> = []): FrameCapture {
  const snap: Snapshot = { html, baseUrl: url, url, title: "", manifest: [], fonts: [], warnings: [] };
  return { snap, url, depth, children: new Map(children) };
}

function context(): { ctx: BuildContext; warnings: string[] } {
  const warnings: string[] = [];
  const resolver = { get: async () => null } as unknown as Resolver;
  const ctx: BuildContext = {
    resolver,
    fetched: () => false,
    warn: (m) => warnings.push(m),
    built: { removed: { elements: 0, attributes: 0 }, frames: 0, fontFacesDropped: 0 },
  };
  return { ctx, warnings };
}

const M = FRAME_ATTRIBUTE;

describe("buildFrame: child frames", () => {
  it("writes a captured iframe as srcdoc, and warns for an iframe the page never loaded", async () => {
    const top = node(
      `<!doctype html><body><iframe ${M}="f1" src="http://a.test/in.html" loading="lazy"></iframe><iframe src="http://a.test/never.html"></iframe></body>`,
      "http://a.test/",
      0,
      [["f1", node(`<!doctype html><body><p>inner</p></body>`, "http://a.test/in.html", 1)]],
    );
    const { ctx, warnings } = context();
    const html = serializeDocument(await buildFrame(top, ctx));
    expect(html).toContain(`srcdoc="<!DOCTYPE html>`);
    expect(html).toContain(`<body><p>inner</p></body></html>"></iframe>`);
    expect(html).not.toContain("in.html");
    expect(html).not.toContain(M);
    expect(warnings).toEqual(["iframe http://a.test/never.html: not loaded by the page; left empty"]);
    expect(ctx.built.frames).toBe(1);
  });

  it("warns for a <frame> even when its document was captured, and for none twice when a child failed", async () => {
    const top = node(
      `<!doctype html><frameset cols="50%,50%"><frame ${M}="f1" src="http://a.test/left.html"><frame ${M}="f2" src="http://a.test/right.html"></frameset>`,
      "http://a.test/",
      0,
      [
        ["f1", node(`<!doctype html><body>left</body>`, "http://a.test/left.html", 1)],
        ["f2", null],
      ],
    );
    const { ctx, warnings } = context();
    const html = serializeDocument(await buildFrame(top, ctx));
    expect(warnings).toEqual(["frame http://a.test/left.html: <frame> is not supported; left empty"]);
    expect(html).not.toContain("left.html");
    expect(html).not.toContain(M);
  });

  it("sets aside the srcdoc of an iframe that was not captured, so its resources are not fetched from disk", async () => {
    const top = node(
      `<!doctype html><body><iframe ${M}="f1" srcdoc="<img src='http://a.test/deep.png'>"></iframe>` +
        `<iframe srcdoc="<img src='http://a.test/lost.png'>"></iframe>` +
        `<iframe src="http://a.test/never.html" srcdoc="<img src='http://a.test/both.png'>"></iframe></body>`,
      "http://a.test/",
      0,
      [["f1", null]],
    );
    const { ctx, warnings } = context();
    const html = serializeDocument(await buildFrame(top, ctx));
    // too deep (null): snapshotFrames already warned "left empty"; the other two warn here
    expect(warnings).toEqual([
      "iframe srcdoc: not captured; left empty, its srcdoc set aside",
      "iframe http://a.test/never.html: not loaded by the page; left empty, its srcdoc set aside",
    ]);
    expect(html).not.toMatch(/\ssrcdoc=/);
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/);
    expect(html.split("data-page-archiver-unfetched-srcdoc=").length - 1).toBe(3);
    expect(html).toContain(`<iframe data-page-archiver-unfetched-srcdoc="<html><head></head><body><img src=&quot;http://a.test/deep.png&quot;></body></html>"></iframe>`);
  });

  it("does not leave the frame marker on an <object> or <embed>", async () => {
    const top = node(`<!doctype html><body><object ${M}="f1" type="image/svg+xml"></object><embed ${M}="f2"></body>`, "http://a.test/", 0, [
      ["f1", node(`<!doctype html><body>o</body>`, "http://a.test/o.svg", 1)],
      ["f2", null],
    ]);
    const { ctx } = context();
    expect(serializeDocument(await buildFrame(top, ctx))).not.toContain(M);
  });
});

describe("fetchForPage", () => {
  type Answer = { status: number; headers?: Record<string, string>; body?: string };
  function requester(answers: Record<string, Answer>) {
    const asked: string[] = [];
    const request = {
      get: async (url: string) => {
        asked.push(url);
        const a = answers[url] ?? { status: 404 };
        return { status: () => a.status, headers: () => a.headers ?? {}, body: async () => Buffer.from(a.body ?? ""), dispose: async () => undefined };
      },
    } as unknown as Parameters<typeof fetchForPage>[0];
    return { request, asked };
  }
  const page = { pageUrl: "https://news.example/a", server: "http://127.0.0.1:47320/" };

  it("refuses a private-network host and the library server before asking for them", async () => {
    const { request, asked } = requester({});
    await expect(fetchForPage(request, "http://127.0.0.1:47320/", page)).rejects.toThrow(/^refused: a loopback address other than the page's own host$/);
    await expect(fetchForPage(request, "http://169.254.169.254/latest/meta-data/", page)).rejects.toThrow(/^refused: a link-local address/);
    await expect(fetchForPage(request, "http://localhost:47320/", { pageUrl: "http://127.0.0.1:47310/p.html", server: page.server })).rejects.toThrow(
      /^refused: a loopback address other than the page's own host$/,
    );
    await expect(fetchForPage(request, "http://127.0.0.1:47320/", { pageUrl: "http://127.0.0.1:47310/p.html", server: page.server })).rejects.toThrow(
      /^refused: the page-archiver server \(http:\/\/127\.0\.0\.1:47320\), not the page itself$/,
    );
    expect(asked).toEqual([]);
  });

  it("follows a redirect only to a host it may fetch, checking each hop first", async () => {
    const { request, asked } = requester({
      "https://cdn.example/a.png": { status: 302, headers: { location: "/b.png" } },
      "https://cdn.example/b.png": { status: 200, headers: { "content-type": "image/png" }, body: "png" },
      "https://cdn.example/evil.png": { status: 301, headers: { location: "http://192.168.1.1/admin" } },
    });
    await expect(fetchForPage(request, "https://cdn.example/a.png", page)).resolves.toMatchObject({ status: 200, mime: "image/png" });
    await expect(fetchForPage(request, "https://cdn.example/evil.png", page)).rejects.toThrow(/^refused: redirected to http:\/\/192\.168\.1\.1\/admin, a private network address/);
    expect(asked).toEqual(["https://cdn.example/a.png", "https://cdn.example/b.png", "https://cdn.example/evil.png"]);
  });

  it("gives up on an endless redirect", async () => {
    const { request } = requester({ "https://loop.example/": { status: 302, headers: { location: "/" } } });
    await expect(fetchForPage(request, "https://loop.example/", page)).rejects.toThrow(/^more than 20 redirects$/);
  });
});
