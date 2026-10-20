// What the popup, the service worker and the content script say to each other.
import type { Snapshot } from "@page-archiver/serializer";

/** The popup asks the service worker to save a tab. */
export interface SaveMessage {
  type: "page-archiver:save";
  tabId: number;
  tags: string[];
}

export function isSaveMessage(m: unknown): m is SaveMessage {
  const x = m as Partial<SaveMessage> | null;
  return !!x && x.type === "page-archiver:save" && typeof x.tabId === "number" && Array.isArray(x.tags) && x.tags.every((t) => typeof t === "string");
}

export type SaveResult =
  /** In the library: `libraryUrl` is the reader UI, `page` the new capture's id. */
  | { kind: "saved"; url: string; title: string; pageId: string; libraryUrl: string; warnings: string[] }
  /** The library could not take it: archive.html went to the downloads folder instead. */
  | { kind: "downloaded"; url: string; title: string; filename: string; downloadId: number; reason: string; warnings: string[] }
  | { kind: "failed"; url: string; error: string };

/** One frame's answer to the content script's snapshot(). */
export interface FrameReport {
  snap: Snapshot;
  /** The id the parent frame gave this frame's element; null for the top frame or an unreached one. */
  id: string | null;
  /** Every URL the frame's document fetched (resource timing), to narrow fonts' src lists. */
  loaded: string[];
}

/** One frame's answer to mark(): the child frames it marked, by id, with their src. */
export interface MarkedFrame {
  id: string;
  src: string;
}

/** The content script's API, at globalThis.__pageArchiver in every frame's isolated world. */
export interface ContentApi {
  mark(nonce: string): MarkedFrame[];
  frameId(nonce: string): string | null;
  snapshot(nonce: string): Promise<FrameReport>;
  unmark(): void;
}

/** The key the session store keeps a tab's last result under. */
export const resultKey = (tabId: number) => `result:${tabId}`;

/** chrome.storage.local keys. */
export const SERVER_KEY = "server";
export const TOKEN_KEY = "token";
