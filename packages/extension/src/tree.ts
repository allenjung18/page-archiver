// The frames' reports, gathered from every frame of the tab at once, made into the frame tree
// core's assemble() builds: each child is found by the id its parent's element was marked with.
import type { FrameCapture } from "@page-archiver/core/portable";
import type { FrameReport, MarkedFrame } from "./protocol.ts";
import { FRAME_ATTRIBUTE } from "./content.ts";

export interface TreeInput {
  /** frameId 0 is the top frame. */
  reports: Array<{ frameId: number; report: FrameReport | null | undefined }>;
  /** Every child frame marked, by id, with its element's src. */
  marked: MarkedFrame[];
  maxDepth: number;
}

export interface Tree {
  tree: FrameCapture;
  /** Every URL any frame loaded. */
  loaded: Set<string>;
  warnings: string[];
}

const MARK = new RegExp(`\\s${FRAME_ATTRIBUTE}="([^"]+)"`, "g");

export function buildTree(input: TreeInput): Tree {
  const top = input.reports.find((r) => r.frameId === 0)?.report;
  if (!top) throw new Error("the page's top frame gave no snapshot");
  const byId = new Map<string, FrameReport>();
  const loaded = new Set<string>();
  for (const { report } of input.reports) {
    if (!report) continue;
    for (const u of report.loaded) loaded.add(u);
    if (report.id && report !== top) byId.set(report.id, report);
  }
  const srcOf = new Map(input.marked.map((m) => [m.id, m.src]));
  const warnings: string[] = [];
  const label = (id: string) => srcOf.get(id) || "(no src)";

  const node = (report: FrameReport, depth: number): FrameCapture => {
    const children = new Map<string, FrameCapture | null>();
    for (const m of report.snap.html.matchAll(MARK)) {
      const id = m[1]!;
      if (children.has(id) || !srcOf.has(id)) continue;
      const child = byId.get(id);
      if (!child) {
        warnings.push(`frame ${label(id)}: the extension could not reach it; left empty`);
        children.set(id, null);
      } else if (depth + 1 > input.maxDepth) {
        warnings.push(`frame ${child.snap.url}: nested deeper than ${input.maxDepth} frames; left empty`);
        children.set(id, null);
      } else {
        children.set(id, node(child, depth + 1));
      }
    }
    return { snap: report.snap, url: report.snap.url, depth, children };
  };
  return { tree: node(top, 0), loaded, warnings };
}
