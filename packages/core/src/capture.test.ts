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

  it("does not leave the frame marker on an <object> or <embed>", async () => {
    const top = node(`<!doctype html><body><object ${M}="f1" type="image/svg+xml"></object><embed ${M}="f2"></body>`, "http://a.test/", 0, [
      ["f1", node(`<!doctype html><body>o</body>`, "http://a.test/o.svg", 1)],
      ["f2", null],
    ]);
    const { ctx } = context();
    expect(serializeDocument(await buildFrame(top, ctx))).not.toContain(M);
  });
});
