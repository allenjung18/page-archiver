// snapshot(): the live DOM frozen into an inert clone, serialized, plus the manifest of the
// resource URLs the clone references. The clone lives in a document created with
// createHTMLDocument, which never fetches images or runs scripts, so cloning has no side effects.
// The live tree and the clone are walked in step; open shadow roots are walked the same way into
// declarative shadow roots, so everything below applies inside web components too.
import { canvasToImage, readCanvas } from "./canvas.ts";
import { collapsePicture, freezeImage } from "./images.ts";
import { openShadowRoot, shadowTemplate } from "./shadow.ts";
import { freezeFormState, planScroll } from "./state.ts";
import { adoptedStyles, sheetDisabled, styleElementText } from "./styles.ts";

export interface SnapshotOptions {
  /** Reserved; nothing yet. */
  readonly _?: never;
}

/** A web font face as the page's FontFaceSet reports it; core keeps only @font-face rules of loaded faces. */
export interface FontFaceInfo {
  family: string;
  style: string;
  weight: string;
  stretch: string;
  unicodeRange: string;
  status: string;
}

export interface Snapshot {
  /** The frozen document, doctype included (none when the page had none: quirks mode stays). */
  html: string;
  /** document.baseURI: what relative URLs in `html` resolve against. */
  baseUrl: string;
  /** location.href at snapshot time (after redirects and client-side routing). */
  url: string;
  title: string;
  /**
   * Absolute URLs of the element resources the frozen document references (img, stylesheet and
   * icon links, video posters), deduplicated. url()s inside CSS and style attributes are found
   * when core inlines them.
   */
  manifest: string[];
  /** Every face in document.fonts with its load status. */
  fonts: FontFaceInfo[];
  /** Things the page had that the archive cannot keep, one line each. */
  warnings: string[];
}

interface Walk {
  inert: Document;
  manifest: Set<string>;
  warnings: string[];
  pictures: Element[];
  /** Work that replaces or inserts clone nodes, done after the walk so the paired walkers stay in step. */
  after: Array<() => void>;
}

export function snapshot(opts: SnapshotOptions = {}): Snapshot {
  void opts; // no options yet
  const live = document.documentElement;
  const inert = document.implementation.createHTMLDocument("");
  const clone = inert.importNode(live, true) as HTMLElement;
  const w: Walk = { inert, manifest: new Set(), warnings: [], pictures: [], after: [] };

  freezeTree(live, clone, w);
  // adopted sheets come after every sheet of the document in the cascade, <body> ones included
  const end = clone.querySelector("body") ?? clone.querySelector("head") ?? clone;
  for (const style of adoptedStyles(document, inert)) end.append(style);
  for (const job of w.after) job();
  for (const p of w.pictures) collapsePicture(p);

  return {
    html: doctype(document.doctype) + clone.outerHTML,
    baseUrl: document.baseURI,
    url: location.href,
    title: document.title,
    manifest: [...w.manifest],
    fonts: fontFaces(),
    warnings: w.warnings,
  };
}

/** Walks a live subtree and its structural copy in step, freezing each element's state into the copy. */
function freezeTree(liveRoot: Node, cloneRoot: Node, w: Walk): void {
  const add = (url: string | null | undefined) => {
    if (url && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("about:")) w.manifest.add(url);
  };
  const liveWalk = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT);
  const cloneWalk = w.inert.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);
  // an element root is visited first; a fragment root (a shadow root) is not an element
  let l: Node | null = liveRoot.nodeType === Node.ELEMENT_NODE ? liveWalk.currentNode : liveWalk.nextNode();
  let c: Node | null = cloneRoot.nodeType === Node.ELEMENT_NODE ? cloneWalk.currentNode : cloneWalk.nextNode();
  while (l && c) {
    const le = l as Element;
    const ce = c as Element;
    switch (le.localName) {
      case "img":
        add(freezeImage(le as HTMLImageElement, ce));
        break;
      case "picture":
        w.pictures.push(ce);
        break;
      case "link": {
        const link = le as HTMLLinkElement;
        const rel = link.relList;
        if (link.getAttribute("href") && (rel.contains("stylesheet") || rel.contains("icon"))) {
          ce.setAttribute("href", link.href);
          add(link.href);
        }
        if (rel.contains("stylesheet") && sheetDisabled(link)) ce.setAttribute("media", "not all");
        break;
      }
      case "style": {
        const style = le as HTMLStyleElement;
        const text = styleElementText(style);
        if (text !== null) ce.textContent = text;
        if (sheetDisabled(style)) ce.setAttribute("media", "not all");
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
      case "canvas": {
        const result = readCanvas(le as HTMLCanvasElement);
        if (result.kind === "image") w.after.push(() => canvasToImage(ce, result.dataUrl));
        else if (result.kind === "tainted") w.warnings.push(`canvas ${describe(le)} is tainted by a cross-origin image and cannot be read; it is empty in the archive`);
        else if (result.kind === "cleared") w.warnings.push(`canvas ${describe(le)} is a WebGL canvas that reads back cleared (no preserveDrawingBuffer); it is empty in the archive`);
        break;
      }
      case "input":
      case "textarea":
      case "option":
      case "details":
        freezeFormState(le, ce);
        break;
    }
    const scroll = planScroll(le);
    if (scroll) {
      const target = scroll.target;
      const { left, top } = scroll.padding;
      w.after.push(() => {
        const t = cloneOf(le, ce, target);
        if (!t) return;
        appendStyle(ce, `scroll-padding-top:${top}px;scroll-padding-left:${left}px`);
        appendStyle(t, "scroll-initial-target:nearest");
      });
    }
    const root = openShadowRoot(le);
    if (root) {
      const template = shadowTemplate(root, w.inert);
      for (const child of Array.from(root.childNodes)) template.content.append(w.inert.importNode(child, true));
      freezeTree(root, template.content, w);
      for (const style of adoptedStyles(root, w.inert)) template.content.append(style);
      w.after.push(() => ce.prepend(template));
    }
    l = liveWalk.nextNode();
    c = cloneWalk.nextNode();
  }
}

/** The clone of `liveTarget`, a descendant of `liveBox`, found by the same child-index path under `cloneBox`. */
function cloneOf(liveBox: Element, cloneBox: Element, liveTarget: Element): Element | null {
  const path: number[] = [];
  for (let n: Element | null = liveTarget; n && n !== liveBox; n = n.parentElement) {
    if (!n.parentElement) return null;
    path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
  }
  let c: Element | undefined = cloneBox;
  for (const i of path) c = c?.children[i];
  return c ?? null;
}

function appendStyle(el: Element, decls: string): void {
  const prev = (el.getAttribute("style") ?? "").trim();
  el.setAttribute("style", prev ? `${prev.replace(/;?$/, ";")}${decls}` : decls);
}

function describe(el: Element): string {
  if (el.id) return `#${el.id}`;
  const cls = el.getAttribute("class");
  return cls ? `${el.localName}.${cls.trim().split(/\s+/).join(".")}` : el.localName;
}

function fontFaces(): FontFaceInfo[] {
  const out: FontFaceInfo[] = [];
  const fonts = document.fonts as FontFaceSet & Iterable<FontFace>;
  if (!fonts || typeof (fonts as unknown as { forEach?: unknown }).forEach !== "function") return out;
  fonts.forEach((f: FontFace) => {
    out.push({ family: f.family, style: f.style, weight: f.weight, stretch: f.stretch, unicodeRange: f.unicodeRange, status: f.status });
  });
  return out;
}

function doctype(dt: DocumentType | null): string {
  if (!dt) return "";
  let out = `<!DOCTYPE ${dt.name}`;
  if (dt.publicId) out += ` PUBLIC "${dt.publicId}"`;
  if (dt.systemId) out += `${dt.publicId ? "" : " SYSTEM"} "${dt.systemId}"`;
  return out + ">\n";
}
