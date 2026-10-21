// Runs in every frame of the tab, in the extension's isolated world, after serializer.iife.js
// (the same bundle core injects into the pages it captures). It defines globalThis.__pageArchiver,
// which the service worker calls with chrome.scripting.executeScript:
//
//   mark(nonce)      marks each child frame's element with an id (FRAME_ATTRIBUTE, as core's
//                    frames.ts does) and posts that id into the child frame, so each child can say
//                    which element of its parent it lives in, cross-origin included
//   frameId(nonce)   the id this frame was given by its parent, once the message has arrived
//   snapshot(nonce)  the serializer's snapshot of this frame, its id, and the URLs it loaded
//   unmark()         takes the marks off the live page again
import type { Snapshot } from "@page-archiver/serializer";
import type { ContentApi, FrameReport, MarkedFrame } from "./protocol.ts";

/** core's FRAME_ATTRIBUTE (frames.ts); a test holds the two equal. */
export const FRAME_ATTRIBUTE = "data-page-archiver-frame";
/** The key of the message a parent frame posts into a child frame. */
export const MESSAGE_KEY = "page-archiver:frame-id";
/** core's FONTS_CAP_MS (warnings.ts): how long a snapshot waits for document.fonts.ready; a test holds the two equal. */
export const FONTS_CAP_MS = 5_000;

declare const PageArchiverSerializer: { snapshot(opts: object): Snapshot };

/** Every iframe and frame element in a document, inside open shadow roots too. */
export function frameElements(root: Document | ShadowRoot): HTMLIFrameElement[] {
  const out: HTMLIFrameElement[] = [];
  const walk = (node: Document | ShadowRoot | Element) => {
    for (const el of node.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      if (tag === "iframe" || tag === "frame") out.push(el as HTMLIFrameElement);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The content API for one frame (its window, document and parent passed in for tests). */
export function createContentApi(win: Window): ContentApi {
  const received = new Map<string, string>(); // nonce -> id
  let marked: Element[] = [];

  win.addEventListener(
    "message",
    (e: MessageEvent) => {
      if (e.source !== win.parent || win.parent === win) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || typeof d[MESSAGE_KEY] !== "string" || typeof d["nonce"] !== "string") return;
      received.set(d["nonce"], d[MESSAGE_KEY]);
    },
    true,
  );

  return {
    mark(nonce) {
      const out: MarkedFrame[] = [];
      for (const el of frameElements(win.document)) {
        const child = el.contentWindow;
        if (!child) continue;
        const id = randomId();
        el.setAttribute(FRAME_ATTRIBUTE, id);
        marked.push(el);
        child.postMessage({ [MESSAGE_KEY]: id, nonce }, "*");
        out.push({ id, src: el.getAttribute("src") ?? "" });
      }
      return out;
    },
    frameId: (nonce) => received.get(nonce) ?? null,
    async snapshot(nonce): Promise<FrameReport> {
      // a web font that started loading late and never answers must not hold the save open
      const fonts = win.document.fonts?.ready.then(() => true) ?? Promise.resolve(true);
      const ready = await Promise.race([fonts, new Promise<boolean>((r) => setTimeout(() => r(false), FONTS_CAP_MS))]);
      const snap = PageArchiverSerializer.snapshot({});
      if (!ready) snap.warnings = [...(snap.warnings ?? []), `web fonts not ready after ${FONTS_CAP_MS / 1000} s; captured anyway`];
      const loaded = win.performance.getEntriesByType("resource").map((e) => e.name);
      return { snap, id: received.get(nonce) ?? null, loaded };
    },
    unmark() {
      for (const el of marked) el.removeAttribute(FRAME_ATTRIBUTE);
      marked = [];
    },
  };
}

const g = globalThis as { __pageArchiver?: ContentApi };
// injected again on every save: the first injection's listener and marks stay in charge
if (typeof window !== "undefined" && !g.__pageArchiver) g.__pageArchiver = createContentApi(window);
