// The frame tree, captured recursively. Playwright reaches every frame from Node, cross-origin
// ones included (no CORS: the browser's protocol, not page script), so each frame is snapshotted in
// its own document. Before a frame is snapshotted, each of its child frames' <iframe> elements is
// marked with an id, so the parent's frozen HTML says which element each child goes into. Each
// child becomes its own sanitized, inlined document, written into the <iframe> as srcdoc.
// Nesting deeper than MAX_FRAME_DEPTH is left empty, with a warning.
import type { Snapshot } from "@page-archiver/serializer";

/** Frames nested deeper than this (the top document is depth 0) are left empty. */
export const MAX_FRAME_DEPTH = 5;

/** Marks a live <iframe> with the id of the frame inside it; removed from the archive. */
export const FRAME_ATTRIBUTE = "data-page-archiver-frame";

/** The slice of a Playwright Frame used here (a fake satisfies it in tests). */
export interface FrameLike {
  url(): string;
  childFrames(): FrameLike[];
  frameElement(): Promise<{ evaluate(fn: (el: Element, arg: [string, string]) => void, arg: [string, string]): Promise<unknown>; dispose(): Promise<void> }>;
}

export interface FrameCapture {
  snap: Snapshot;
  url: string;
  depth: number;
  /** Child frames by the id on their element. null: not captured (too deep, or it failed). */
  children: Map<string, FrameCapture | null>;
}

export interface FrameOptions {
  maxDepth?: number | undefined;
  warn(message: string): void;
}

/** Snapshots `frame` and, recursively, every frame inside it. */
export async function snapshotFrames<F extends FrameLike>(
  frame: F,
  snap: (frame: F) => Promise<Snapshot>,
  opts: FrameOptions,
  depth = 0,
  ids = { next: 0 },
): Promise<FrameCapture> {
  const maxDepth = opts.maxDepth ?? MAX_FRAME_DEPTH;
  const marked: Array<{ id: string; child: F }> = [];
  for (const child of frame.childFrames() as F[]) {
    try {
      const el = await child.frameElement();
      const id = `f${++ids.next}`;
      await el.evaluate((e, [name, value]) => e.setAttribute(name, value), [FRAME_ATTRIBUTE, id]);
      await el.dispose();
      marked.push({ id, child });
    } catch (err) {
      opts.warn(`frame ${child.url()}: could not be located (${firstLine(err)}); left empty`);
    }
  }
  const capture: FrameCapture = { snap: await snap(frame), url: frame.url(), depth, children: new Map() };
  for (const { id, child } of marked) {
    if (depth + 1 > maxDepth) {
      opts.warn(`frame ${child.url()}: nested deeper than ${maxDepth} frames; left empty`);
      capture.children.set(id, null);
      continue;
    }
    try {
      capture.children.set(id, await snapshotFrames(child, snap, opts, depth + 1, ids));
    } catch (err) {
      opts.warn(`frame ${child.url()}: could not be captured (${firstLine(err)}); left empty`);
      capture.children.set(id, null);
    }
  }
  return capture;
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0]!;
}
