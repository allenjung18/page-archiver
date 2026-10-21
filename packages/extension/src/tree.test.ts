import { describe, expect, it } from "vitest";
import type { Snapshot } from "@page-archiver/serializer";
import { FRAME_ATTRIBUTE as CORE_FRAME_ATTRIBUTE, FONTS_CAP_MS as CORE_FONTS_CAP_MS, fontsWarning } from "@page-archiver/core/portable";
import { FONTS_CAP_MS, FRAME_ATTRIBUTE } from "./content.ts";
import type { FrameReport } from "./protocol.ts";
import { buildTree } from "./tree.ts";

const M = FRAME_ATTRIBUTE;

function report(html: string, url: string, id: string | null, loaded: string[] = []): FrameReport {
  const snap: Snapshot = { html, baseUrl: url, url, title: "", manifest: [], fonts: [], warnings: [] };
  return { snap, id, loaded };
}

describe("buildTree", () => {
  it("marks frames with the attribute core's buildFrame reads", () => {
    expect(FRAME_ATTRIBUTE).toBe(CORE_FRAME_ATTRIBUTE);
  });

  it("waits for web fonts as long as core's capture does, and says so in the same words", () => {
    expect(FONTS_CAP_MS).toBe(CORE_FONTS_CAP_MS);
    expect(fontsWarning(FONTS_CAP_MS)).toBe("web fonts not ready after 5 s; captured anyway");
  });

  it("puts each frame under the element its parent marked, two deep, and gathers every loaded URL", () => {
    const t = buildTree({
      reports: [
        { frameId: 0, report: report(`<iframe ${M}="a" src="/a"></iframe><iframe ${M}="b" src="/b"></iframe>`, "http://t.test/", null, ["http://t.test/x.css"]) },
        { frameId: 7, report: report(`<iframe ${M}="c" src="/c"></iframe>`, "http://t.test/a", "a", ["http://o.test/f.woff2"]) },
        { frameId: 9, report: report("<p>b</p>", "http://o.test/b", "b") },
        { frameId: 11, report: report("<p>c</p>", "http://o.test/c", "c") },
      ],
      marked: [
        { id: "a", src: "/a" },
        { id: "b", src: "/b" },
        { id: "c", src: "/c" },
      ],
      maxDepth: 5,
    });
    expect(t.warnings).toEqual([]);
    expect([...t.tree.children.keys()]).toEqual(["a", "b"]);
    const a = t.tree.children.get("a")!;
    expect(a).toMatchObject({ url: "http://t.test/a", depth: 1 });
    expect(a.children.get("c")).toMatchObject({ url: "http://o.test/c", depth: 2 });
    expect([...t.loaded]).toEqual(["http://t.test/x.css", "http://o.test/f.woff2"]);
  });

  it("leaves a frame the extension could not reach empty, with a warning naming its src", () => {
    const t = buildTree({
      reports: [{ frameId: 0, report: report(`<iframe ${M}="a" src="https://ads.test/x"></iframe>`, "http://t.test/", null) }],
      marked: [{ id: "a", src: "https://ads.test/x" }],
      maxDepth: 5,
    });
    expect(t.tree.children.get("a")).toBeNull();
    expect(t.warnings).toEqual(["frame https://ads.test/x: the extension could not reach it; left empty"]);
  });

  it("stops at the depth cap, even when a frame claims its own id (no endless tree)", () => {
    const self = report(`<iframe ${M}="a" src="/a"></iframe>`, "http://t.test/a", "a");
    const t = buildTree({
      reports: [
        { frameId: 0, report: report(`<iframe ${M}="a" src="/a"></iframe>`, "http://t.test/", null) },
        { frameId: 3, report: self },
      ],
      marked: [{ id: "a", src: "/a" }],
      maxDepth: 2,
    });
    expect(t.tree.children.get("a")!.children.get("a")!.children.get("a")).toBeNull();
    expect(t.warnings).toEqual(["frame http://t.test/a: nested deeper than 2 frames; left empty"]);
  });

  it("ignores an attribute it did not set, and refuses a tab whose top frame gave nothing", () => {
    const t = buildTree({ reports: [{ frameId: 0, report: report(`<p ${M}="zzz">text</p>`, "http://t.test/", null) }], marked: [], maxDepth: 5 });
    expect(t.tree.children.size).toBe(0);
    expect(() => buildTree({ reports: [{ frameId: 0, report: null }], marked: [], maxDepth: 5 })).toThrow(/top frame/);
  });
});
