// The text the search index holds for a capture: the reader copy's article (its header of
// site, title and byline left out: those are indexed in their own columns), or, for a page with
// no reader copy, the archive's visible text.
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes as T } from "parse5";

/** Elements whose content is never text a reader sees. */
const SKIPPED = new Set(["head", "script", "style", "noscript", "svg", "math", "iframe", "object", "embed", "canvas"]);
/** More than this is not indexed (a page that long is not searched for its last chapter). */
export const MAX_TEXT = 2 * 1024 * 1024;

function collect(node: T.ParentNode, out: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") out.push((child as T.TextNode).value);
    else if ("tagName" in child) {
      const el = child as T.Element;
      if (SKIPPED.has(el.tagName)) continue;
      // a declarative shadow root's content is part of the page
      collect(el.tagName === "template" ? (el as T.Template).content : el, out);
      out.push(" ");
    }
  }
}

function find(node: T.ParentNode, test: (el: T.Element) => boolean): T.Element | null {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    const el = child as T.Element;
    if (test(el)) return el;
    const hit = find(el.tagName === "template" ? (el as T.Template).content : el, test);
    if (hit) return hit;
  }
  return null;
}

function hasClass(el: T.Element, name: string): boolean {
  const cls = el.attrs.find((a) => a.name === "class")?.value ?? "";
  return cls.split(/\s+/).includes(name);
}

function textOf(root: T.ParentNode): string {
  const out: string[] = [];
  collect(root, out);
  return out.join("").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/** The article text of a reader.html (its .pa-content), else its body's text. */
export function readerText(html: string): string {
  const doc = parse(html);
  const content = find(doc, (el) => hasClass(el, "pa-content")) ?? find(doc, (el) => el.tagName === "body") ?? doc;
  return textOf(content);
}

/** The visible text of an archive.html's body. */
export function archiveText(html: string): string {
  const doc = parse(html);
  return textOf(find(doc, (el) => el.tagName === "body") ?? doc);
}
