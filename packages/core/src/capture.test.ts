import { describe, expect, it } from "vitest";
import type { Snapshot } from "@page-archiver/serializer";
import { buildFrame, type BuildContext } from "./capture.ts";
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
