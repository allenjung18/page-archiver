// The frozen document made self-contained: stylesheets become <style> (via inline/css.ts),
// images and other resource attributes become data: URIs, an image in an <object> or <embed>
// becomes an <img>, the symbols an SVG <use> takes from an external sprite are copied into the
// document, a resource that cannot be had is set aside (UNFETCHED_ATTRIBUTE_PREFIX) so the
// archive never asks the network for it, and links are made absolute so they still lead to the
// live web from the archive.
import { utf8 } from "../bytes.ts";
import {
  allElements,
  appendChild,
  cloneElement,
  createElement,
  detach,
  getAttr,
  isElement,
  parseFragment,
  removeAttr,
  replaceWith,
  setAttr,
  setStyleText,
  SVG_NAMESPACE,
  textOf,
  tokens,
  type Document,
  type Element,
  type ParentNode,
} from "../dom.ts";
import { sanitizeDocument } from "../sanitize.ts";
import { decodeCss, inlineCss, inlineUrls, type CssContext } from "./css.ts";
import { effectiveMime, normalizeMime, toDataUri } from "./datauri.ts";

export interface HtmlContext extends CssContext {
  /** What relative URLs in the document resolve against (the snapshot's document.baseURI). */
  baseUrl: string;
}

/** Absolute http(s) URL for an attribute value, or null when it is not one to fetch. */
function fetchable(value: string | null, base: string): string | null {
  if (!value || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** A navigation URL made absolute; fragment-only, javascript: and unparseable values are left alone. */
export function absoluteLink(value: string, base: string): string {
  const v = value.trim();
  if (!v || v.startsWith("#") || /^javascript:/i.test(v)) return value;
  try {
    return new URL(v, base).href;
  } catch {
    return value;
  }
}

/**
 * Where an attribute naming a resource the capture could not have keeps its absolute URL
 * (`data-page-archiver-unfetched-src` for an `img src`): left in place, opening the file from disk
 * would fetch it from the live site, and served under the archive CSP it is a refused request.
 */
export const UNFETCHED_ATTRIBUTE_PREFIX = "data-page-archiver-unfetched-";

/** Moves `name`'s URL into its UNFETCHED_ATTRIBUTE_PREFIX attribute. */
function setUnfetchedAside(el: Element, name: string, url: string): void {
  removeAttr(el, name);
  setAttr(el, UNFETCHED_ATTRIBUTE_PREFIX + name, url);
}

/** Replaces a URL attribute with a data: URI of the resource, or sets it aside when it cannot be had. */
async function inlineAttr(el: Element, name: string, ctx: HtmlContext, dropOnFailure = false): Promise<void> {
  const url = fetchable(getAttr(el, name), ctx.baseUrl);
  if (!url) return;
  const res = await ctx.get(url);
  if (res) setAttr(el, name, toDataUri(res.bytes, res.mime));
  else if (dropOnFailure) detach(el);
  else setUnfetchedAside(el, name, url);
}

async function inlineStylesheetLink(link: Element, ctx: HtmlContext): Promise<void> {
  const rel = tokens(link, "rel");
  const href = fetchable(getAttr(link, "href"), ctx.baseUrl);
  if (!href) return;
  if (rel.includes("alternate")) {
    ctx.warn(`${href}: alternate stylesheet dropped`);
    detach(link);
    return;
  }
  const res = await ctx.get(href);
  if (!res) {
    setUnfetchedAside(link, "href", href);
    return;
  }
  const style = createElement("style");
  for (const name of ["media", "title"]) {
    const v = getAttr(link, name);
    if (v !== null) setAttr(style, name, v);
  }
  setStyleText(style, await inlineCss(decodeCss(res.bytes), href, ctx));
  replaceWith(link, style);
}

/** <link rel> tokens of an icon the browser fetches for itself: inlined, or dropped when it cannot be had. */
export const ICON_RELS = ["icon", "apple-touch-icon", "apple-touch-icon-precomposed"] as const;

/**
 * Where a <video>, <audio>, <source> or <track> keeps the address of its media: video and audio
 * files are not archived (a capture keeps a video's poster frame, not its stream), and a `src`
 * left in place would reach the network from the archive.
 */
export const MEDIA_SRC_ATTRIBUTE = "data-page-archiver-src";

/**
 * The picture a <video> showed when the page was captured, a data: PNG set on the live element by
 * capture() before the snapshot (posters.ts). It becomes the archived video's poster.
 */
export const POSTER_FRAME_ATTRIBUTE = "data-page-archiver-poster";

/**
 * The live video's own aspect ratio ("<videoWidth> / <videoHeight>"), set beside the poster frame.
 * A screenshot is whole pixels, so its ratio is a little off the video's; the archived video gets
 * the video's ratio as `aspect-ratio`, so its box is the height it was.
 */
export const VIDEO_RATIO_ATTRIBUTE = "data-page-archiver-ratio";

/** Moves a media element's or <source>/<track>'s non-data: src aside; returns the absolute URL moved, or null. */
function setMediaAside(el: Element, base: string): string | null {
  const src = getAttr(el, "src");
  if (src === null) return null;
  removeAttr(el, "src");
  const v = src.trim();
  if (!v) return null;
  if (/^data:/i.test(v)) {
    // already inside the file: nothing reaches the network
    setAttr(el, "src", src);
    return null;
  }
  const url = absoluteLink(v, base);
  setAttr(el, MEDIA_SRC_ATTRIBUTE, url);
  return url;
}

/** A <video> or <audio> made inert: its sources set aside, a video's poster frame made its poster. */
function freezeMedia(el: Element, ctx: HtmlContext): void {
  const moved: string[] = [];
  const own = setMediaAside(el, ctx.baseUrl);
  if (own) moved.push(own);
  for (const child of el.childNodes) {
    if (!isElement(child) || (child.tagName !== "source" && child.tagName !== "track")) continue;
    const url = setMediaAside(child, ctx.baseUrl);
    if (url && child.tagName === "source") moved.push(url);
  }
  const frame = getAttr(el, POSTER_FRAME_ATTRIBUTE);
  removeAttr(el, POSTER_FRAME_ATTRIBUTE);
  // the frame is what the reader saw (a playing video's picture, or the poster it showed)
  const ratio = getAttr(el, VIDEO_RATIO_ATTRIBUTE);
  removeAttr(el, VIDEO_RATIO_ATTRIBUTE);
  if (el.tagName === "video" && frame !== null && /^data:image\/(png|jpeg|webp);base64,/i.test(frame)) {
    setAttr(el, "poster", frame);
    if (ratio !== null && /^[1-9]\d{0,5} \/ [1-9]\d{0,5}$/.test(ratio)) {
      const style = (getAttr(el, "style") ?? "").trim();
      setAttr(el, "style", `${style}${style && !style.endsWith(";") ? ";" : ""}${style ? " " : ""}aspect-ratio: ${ratio}`);
    }
  }
  if (moved.length) {
    const keeps = el.tagName === "video" ? (getAttr(el, "poster") ? "the poster frame is kept" : "it has no poster frame") : "nothing of it is kept";
    ctx.warn(`${el.tagName} ${moved[0]}: media not archived; ${keeps}`);
  }
}

const LINK_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  area: ["href"],
  form: ["action"],
  button: ["formaction"],
  input: ["formaction"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite"],
  ins: ["cite"],
};

/**
 * Attributes of an <object> or <embed> that mean nothing on the <img> it becomes: where the
 * resource was, its declared type, and plugin parameters.
 */
const EMBEDDED_ONLY_ATTRIBUTES = ["data", "src", "type", "typemustmatch", "codebase", "codetype", "classid", "archive", "declare", "standby", "form", "pluginspage", "pluginurl"];

/**
 * An <object data> or <embed src>. An image becomes an <img> of it in the element's place (the
 * <img> keeps the element's other attributes); anything else (a document, a PDF, a plugin) is set
 * aside with a warning. A data: URL is never put back into the element: there it is a document,
 * which can carry script, and the sanitizer removed it for that reason.
 */
async function inlineEmbedded(el: Element, ctx: HtmlContext): Promise<void> {
  const name = el.tagName === "object" ? "data" : "src";
  const url = fetchable(getAttr(el, name), ctx.baseUrl);
  if (!url) return;
  const type = getAttr(el, "type");
  const setAside = (why: string | null) => {
    if (why) ctx.warn(`${el.tagName} ${url}: ${why}; set aside`);
    setUnfetchedAside(el, name, url);
    // left with only its type, Chromium still starts the plugin for it (a PDF viewer), which the
    // archive CSP refuses as an object-src violation; with neither, the fallback content shows
    if (type !== null) setUnfetchedAside(el, "type", type);
  };
  const declared = normalizeMime(type);
  // not fetched: a PDF or a plugin's file can be large, and it would be thrown away
  if (declared && !declared.startsWith("image/")) return setAside(`${declared} is not an image`);
  const res = await ctx.get(url);
  if (!res) return setAside(null); // the resolver has warned
  const mime = effectiveMime(res.mime, res.bytes);
  if (!mime.startsWith("image/")) return setAside(`${mime} is not an image`);
  const img = createElement("img");
  img.attrs = el.attrs.filter((a) => !EMBEDDED_ONLY_ATTRIBUTES.includes(a.name)).map((a) => ({ ...a }));
  setAttr(img, "src", toDataUri(res.bytes, res.mime));
  replaceWith(el, img);
}

/** Marks the hidden <svg> holding what was copied from external SVG sprites: one per document or shadow root. */
export const SPRITES_ATTRIBUTE = "data-page-archiver-sprites";

/** What an id copied from an external sprite becomes: this, the sprite's number, "-", the id. */
export const SPRITE_ID_PREFIX = "page-archiver-sprite-";

const spriteId = (n: number, id: string) => `${SPRITE_ID_PREFIX}${n}-${id}`;

/** An external SVG file a <use> takes an element from, parsed and sanitized once per document. */
interface Sprite {
  n: number;
  /** Its elements by id (the first of each), or null when the file is not SVG. */
  byId: Map<string, Element> | null;
  mime: string;
}

interface SpriteState {
  /** By the sprite's URL, without its fragment. */
  sheets: Map<string, Promise<Sprite | null>>;
  /** Per tree (the document, or a shadow root's content): the <defs> copies go into, and the "<n>#<id>"s already in it. */
  scopes: Map<ParentNode, { defs: Element; copied: Set<string> }>;
}

function loadSprite(url: string, ctx: HtmlContext, state: SpriteState): Promise<Sprite | null> {
  let sheet = state.sheets.get(url);
  if (!sheet) {
    const n = state.sheets.size;
    sheet = ctx.get(url).then((res) => {
      if (!res) return null;
      const mime = effectiveMime(res.mime, res.bytes);
      if (mime !== "image/svg+xml") return { n, byId: null, mime };
      const tree = parseFragment(utf8(res.bytes).replace(/^\uFEFF/, ""));
      // the sprite is copied into the archive, so what it holds is held to the archive's rules
      sanitizeDocument(tree);
      const byId = new Map<string, Element>();
      for (const e of allElements(tree)) {
        const id = getAttr(e, "id");
        if (id !== null && !byId.has(id)) byId.set(id, e);
      }
      return { n, byId, mime };
    });
    state.sheets.set(url, sheet);
  }
  return sheet;
}

/** The root of el's tree: the document, or the content of the <template> (a shadow root) it is in. */
function treeOf(el: Element): ParentNode {
  let node: ParentNode = el;
  for (let up = (node as { parentNode?: ParentNode | null }).parentNode; up; up = (up as { parentNode?: ParentNode | null }).parentNode) node = up;
  return node;
}

/** The <defs> of the tree's hidden sprite <svg>, made at the end of its <body> (or of the shadow root) on first use. */
function spriteScope(tree: ParentNode, state: SpriteState): { defs: Element; copied: Set<string> } {
  let scope = state.scopes.get(tree);
  if (scope) return scope;
  const svg = createElement(
    "svg",
    { [SPRITES_ATTRIBUTE]: "", "aria-hidden": "true", width: "0", height: "0", style: "position: absolute; width: 0; height: 0; overflow: hidden" },
    SVG_NAMESPACE,
  );
  const defs = createElement("defs", {}, SVG_NAMESPACE);
  appendChild(svg, defs);
  const html = tree.childNodes.find((n): n is Element => isElement(n) && n.tagName === "html");
  const body = html?.childNodes.find((n): n is Element => isElement(n) && n.tagName === "body");
  appendChild(body ?? html ?? tree, svg);
  scope = { defs, copied: new Set() };
  state.scopes.set(tree, scope);
  return scope;
}

/** `#id` references in a value: an href that is one, and every url(#id). */
const URL_ID_REF = /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/gi;

function fragmentId(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/**
 * Copies sprite element `id`, and every element it refers to by #id (a gradient, a clip path,
 * another symbol), into the scope's <defs>, each id renamed to spriteId so it cannot collide with
 * the page's own. Returns the copies made (none when they are there already).
 */
function copyFromSprite(sprite: Sprite & { byId: Map<string, Element> }, id: string, scope: { defs: Element; copied: Set<string> }): Element[] {
  const copies: Element[] = [];
  const queue = [id];
  while (queue.length) {
    const want = queue.shift()!;
    const source = sprite.byId.get(want);
    if (!source || scope.copied.has(`${sprite.n}#${want}`)) continue;
    const copy = cloneElement(source);
    for (const e of [copy, ...allElements(copy)]) {
      for (const a of e.attrs) {
        if (a.name === "id") {
          scope.copied.add(`${sprite.n}#${a.value}`);
          a.value = spriteId(sprite.n, a.value);
        } else if (a.name === "href" && a.value.trim().startsWith("#")) {
          const ref = fragmentId(a.value.trim().slice(1));
          queue.push(ref);
          a.value = `#${spriteId(sprite.n, ref)}`;
        } else if (/url\(/i.test(a.value)) {
          a.value = a.value.replace(URL_ID_REF, (_, q: string, ref: string) => {
            queue.push(ref);
            return `url(${q}#${spriteId(sprite.n, ref)}${q})`;
          });
        }
      }
      if (e.tagName === "style") {
        setStyleText(
          e,
          textOf(e).replace(URL_ID_REF, (_, q: string, ref: string) => {
            queue.push(ref);
            return `url(${q}#${spriteId(sprite.n, ref)}${q})`;
          }),
        );
      }
    }
    scope.copied.add(`${sprite.n}#${want}`);
    appendChild(scope.defs, copy);
    copies.push(copy);
  }
  return copies;
}

/**
 * An SVG <use> that takes its element from another file (an icon sprite): the element, and what it
 * refers to, is copied into the document and the <use> made to point at the copy. One that cannot
 * be had is set aside, with a warning.
 */
async function inlineUse(el: Element, ctx: HtmlContext, state: SpriteState): Promise<void> {
  const raw = getAttr(el, "href"); // xlink:href too: parse5 names it href, in the xlink namespace
  if (raw === null || raw.trim().startsWith("#")) return;
  const url = fetchable(raw, ctx.baseUrl);
  if (!url) return;
  const parts = new URL(url);
  const id = fragmentId(parts.hash.slice(1));
  parts.hash = "";
  const sheetUrl = parts.href;
  const setAside = (why: string | null) => {
    if (why) ctx.warn(`use ${url}: ${why}; set aside`);
    setUnfetchedAside(el, "href", url);
  };
  if (!id) return setAside("names no element of the file");
  const sprite = await loadSprite(sheetUrl, ctx, state);
  if (!sprite) return setAside(null); // the resolver has warned
  if (!sprite.byId) return setAside(`${sprite.mime} is not an SVG file`);
  if (!sprite.byId.has(id)) return setAside(`the file has no element with id "${id}"`);
  const copies = copyFromSprite({ ...sprite, byId: sprite.byId }, id, spriteScope(treeOf(el), state));
  for (const a of el.attrs) if (a.name === "href") a.value = `#${spriteId(sprite.n, id)}`;
  // what the copies refer to (an <image>, a nested sprite) is relative to the sprite's own URL
  await inlineElements(
    copies.flatMap((c) => [c, ...allElements(c)]),
    { ...ctx, baseUrl: sheetUrl },
    state,
  );
}

/** Inlines every resource doc references and makes its links absolute, in place. */
export async function inlineDocument(doc: Document, ctx: HtmlContext): Promise<void> {
  await inlineElements(allElements(doc), ctx, { sheets: new Map(), scopes: new Map() });
}

async function inlineElements(elements: readonly Element[], ctx: HtmlContext, sprites: SpriteState): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const el of elements) {
    const tag = el.tagName;
    // first: it may add to the style attribute, whose url()s are inlined next
    if (tag === "video" || tag === "audio") freezeMedia(el, ctx);
    for (const name of LINK_ATTRIBUTES[tag] ?? []) {
      const v = getAttr(el, name);
      if (v !== null) setAttr(el, name, absoluteLink(v, ctx.baseUrl));
    }
    const style = getAttr(el, "style");
    if (style !== null && /url\(/i.test(style)) {
      jobs.push(inlineUrls(style, ctx.baseUrl, ctx).then((v) => setAttr(el, "style", v)));
    }
    if (getAttr(el, "background") !== null) jobs.push(inlineAttr(el, "background", ctx));
    switch (tag) {
      case "link": {
        const rel = tokens(el, "rel");
        if (rel.includes("stylesheet")) jobs.push(inlineStylesheetLink(el, ctx));
        else if (rel.some((r) => (ICON_RELS as readonly string[]).includes(r))) jobs.push(inlineAttr(el, "href", ctx, true));
        else {
          const href = getAttr(el, "href");
          if (href !== null) setAttr(el, "href", absoluteLink(href, ctx.baseUrl));
        }
        break;
      }
      case "style":
        jobs.push(inlineCss(textOf(el), ctx.baseUrl, ctx).then((css) => setStyleText(el, css)));
        break;
      case "img":
        removeAttr(el, "srcset");
        removeAttr(el, "sizes");
        removeAttr(el, "loading");
        jobs.push(inlineAttr(el, "src", ctx));
        break;
      case "input":
        if ((getAttr(el, "type") ?? "").toLowerCase() === "image") jobs.push(inlineAttr(el, "src", ctx));
        break;
      case "video":
        jobs.push(inlineAttr(el, "poster", ctx));
        break;
      case "image": // SVG <image href> / <image xlink:href>
      case "feImage":
        jobs.push(inlineAttr(el, "href", ctx));
        break;
      case "object":
      case "embed":
        jobs.push(inlineEmbedded(el, ctx));
        break;
      case "use": // SVG <use href> / <use xlink:href>
        jobs.push(inlineUse(el, ctx, sprites));
        break;
    }
  }
  await Promise.all(jobs);
}
