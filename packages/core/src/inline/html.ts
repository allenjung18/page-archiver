// The frozen document made self-contained: stylesheets become <style> (via inline/css.ts),
// images and other resource attributes become data: URIs, and links are made absolute so they
// still lead to the live web from the archive.
import {
  allElements,
  createElement,
  detach,
  getAttr,
  removeAttr,
  replaceWith,
  setAttr,
  setStyleText,
  textOf,
  tokens,
  type Document,
  type Element,
} from "../dom.ts";
import { decodeCss, inlineCss, inlineUrls, type CssContext } from "./css.ts";
import { toDataUri } from "./datauri.ts";

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

/** Replaces a URL attribute with a data: URI of the resource, or the absolute URL when it cannot be had. */
async function inlineAttr(el: Element, name: string, ctx: HtmlContext, dropOnFailure = false): Promise<void> {
  const url = fetchable(getAttr(el, name), ctx.baseUrl);
  if (!url) return;
  const res = await ctx.get(url);
  if (res) setAttr(el, name, toDataUri(res.bytes, res.mime));
  else if (dropOnFailure) detach(el);
  else setAttr(el, name, url);
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
    setAttr(link, "href", href);
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

/** Inlines every resource doc references and makes its links absolute, in place. */
export async function inlineDocument(doc: Document, ctx: HtmlContext): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const el of allElements(doc)) {
    const tag = el.tagName;
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
        else if (rel.includes("icon") || rel.includes("apple-touch-icon")) jobs.push(inlineAttr(el, "href", ctx, true));
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
    }
  }
  await Promise.all(jobs);
}
