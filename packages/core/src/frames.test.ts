import { describe, expect, it } from "vitest";
import type { Snapshot } from "@page-archiver/serializer";
import { FRAME_ATTRIBUTE, snapshotFrames, type FrameLike } from "./frames.ts";

interface Fake extends FrameLike {
  name: string;
  marks: Array<[string, string]>;
  childFrames(): Fake[];
}

/** A frame tree: each frame's element records the attribute written on it. */
function frame(name: string, children: Fake[] = [], o: { noElement?: boolean } = {}): Fake {
  const f: Fake = {
    name,
    marks: [],
    url: () => `http://f.test/${name}`,
    childFrames: () => children,
    frameElement: async () => {
      if (o.noElement) throw new Error("detached");
      return {
        evaluate: async (fn, arg) => {
          f.marks.push(arg);
          void fn;
        },
        dispose: async () => undefined,
      };
    },
  };
  return f;
}

function snap(f: Fake): Promise<Snapshot> {
  if (f.name === "broken") return Promise.reject(new Error("Execution context was destroyed\nmore"));
  return Promise.resolve({ html: `<p>${f.name}</p>`, baseUrl: f.url(), url: f.url(), title: f.name, manifest: [], fonts: [], warnings: [] });
}

describe("snapshotFrames", () => {
  it("marks each child's element with an id before the parent is snapshotted, and recurses", async () => {
    const leaf = frame("leaf");
    const a = frame("a", [leaf]);
    const b = frame("b");
    const top = frame("top", [a, b]);
    const warnings: string[] = [];
    const tree = await snapshotFrames(top, snap, { warn: (m) => warnings.push(m) });
    expect(a.marks).toEqual([[FRAME_ATTRIBUTE, "f1"]]);
    expect(b.marks).toEqual([[FRAME_ATTRIBUTE, "f2"]]);
    expect(leaf.marks).toEqual([[FRAME_ATTRIBUTE, "f3"]]);
    expect(tree.snap.title).toBe("top");
    expect([...tree.children.keys()]).toEqual(["f1", "f2"]);
    expect(tree.children.get("f1")!.children.get("f3")!.snap.title).toBe("leaf");
    expect(tree.children.get("f1")!.depth).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("leaves frames past the depth cap empty, with a warning", async () => {
    // top > d1 > d2 > d3: with a cap of 2, d3 is not captured
    const d3 = frame("d3");
    const warnings: string[] = [];
    const tree = await snapshotFrames(frame("top", [frame("d1", [frame("d2", [d3])])]), snap, { maxDepth: 2, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(["frame http://f.test/d3: nested deeper than 2 frames; left empty"]);
    const d2 = tree.children.get("f1")!.children.get("f2")!;
    expect(d2.children.get("f3")).toBeNull();
    expect(d3.marks).toEqual([[FRAME_ATTRIBUTE, "f3"]]);
  });

  it("warns and goes on when a child cannot be located or snapshotted", async () => {
    const warnings: string[] = [];
    const tree = await snapshotFrames(frame("top", [frame("gone", [], { noElement: true }), frame("broken"), frame("ok")]), snap, {
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([
      "frame http://f.test/gone: could not be located (detached); left empty",
      "frame http://f.test/broken: could not be captured (Execution context was destroyed); left empty",
    ]);
    expect([...tree.children.entries()].map(([id, c]) => [id, c?.snap.title ?? null])).toEqual([
      ["f1", null],
      ["f2", "ok"],
    ]);
  });
});
