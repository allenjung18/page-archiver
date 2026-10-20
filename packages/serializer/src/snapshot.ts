// snapshot(): the live DOM frozen into an inert clone, serialized, plus the manifest of the
// resource URLs the clone references. The clone lives in a document created with
// createHTMLDocument, which never fetches images or runs scripts, so cloning has no side effects.
import { collapsePicture, freezeImage } from "./images.ts";

export interface SnapshotOptions {
  /** Reserved for chunk 2 (frames, shadow roots, CSSOM); nothing yet. */
  readonly _?: never;
}

export interface Snapshot {
  /** The frozen document, doctype included (none when the page had none: quirks mode stays). */
  html: string;
  /** document.baseURI: what relative URLs in `html` resolve against. */
  baseUrl: string;
  /** location.href at snapshot time (after redirects and client-side routing). */
  url: string;
  title: string;
  /** Absolute URLs of every resource the frozen document references, deduplicated. */
  manifest: string[];
}

export function snapshot(opts: SnapshotOptions = {}): Snapshot {
  void opts; // no options yet
  const live = document.documentElement;
  const inert = document.implementation.createHTMLDocument("");
  const clone = inert.importNode(live, true) as HTMLElement;
  const manifest = new Set<string>();
  const add = (url: string | null | undefined) => {
    if (url && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("about:")) manifest.add(url);
  };

  // Both trees have the same shape (importNode is a deep structural copy), so a pair of tree
  // walkers visits matching elements in step.
  const liveWalk = document.createTreeWalker(live, NodeFilter.SHOW_ELEMENT);
  const cloneWalk = inert.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  const pictures: Element[] = [];
  let l: Node | null = liveWalk.currentNode;
  let c: Node | null = cloneWalk.currentNode;
  while (l && c) {
    const le = l as Element;
    const ce = c as Element;
    switch (le.localName) {
      case "img":
        add(freezeImage(le as HTMLImageElement, ce));
        break;
      case "picture":
        pictures.push(ce);
        break;
      case "link": {
        const link = le as HTMLLinkElement;
        const rel = link.relList;
        if (link.getAttribute("href") && (rel.contains("stylesheet") || rel.contains("icon"))) {
          ce.setAttribute("href", link.href);
          add(link.href);
        }
        break;
      }
      case "video": {
        const poster = le.getAttribute("poster");
        if (poster) {
          const abs = (le as HTMLVideoElement).poster;
          ce.setAttribute("poster", abs);
          add(abs);
        }
        break;
      }
    }
    l = liveWalk.nextNode();
    c = cloneWalk.nextNode();
  }
  for (const p of pictures) collapsePicture(p);

  return {
    html: doctype(document.doctype) + clone.outerHTML,
    baseUrl: document.baseURI,
    url: location.href,
    title: document.title,
    manifest: [...manifest],
  };
}

function doctype(dt: DocumentType | null): string {
  if (!dt) return "";
  let out = `<!DOCTYPE ${dt.name}`;
  if (dt.publicId) out += ` PUBLIC "${dt.publicId}"`;
  if (dt.systemId) out += `${dt.publicId ? "" : " SYSTEM"} "${dt.systemId}"`;
  return out + ">\n";
}
