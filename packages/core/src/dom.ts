// Small helpers over parse5's default tree: the archive is assembled as a parse5 document in
// Node, never in a browser DOM.
import { defaultTreeAdapter as ta, html as html5, parse, parseFragment, serialize, type DefaultTreeAdapterTypes as T } from "parse5";

export type Document = T.Document;
export type Element = T.Element;
export type ParentNode = T.ParentNode;
export type ChildNode = T.ChildNode;

export const parseDocument = (source: string): Document => parse(source);
/**
 * Serializes doc. parse5 writes every doctype as `<!DOCTYPE name>`, which would switch a
 * quirks-mode page into standards mode; the public and system ids are written back here.
 */
export function serializeDocument(doc: Document | T.DocumentFragment): string {
  const html = serialize(doc);
  const dt = doc.childNodes.find((n): n is T.DocumentType => n.nodeName === "#documentType");
  if (!dt || (!dt.publicId && !dt.systemId)) return html;
  const short = `<!DOCTYPE ${dt.name}>`;
  if (!html.startsWith(short)) return html;
  let full = `<!DOCTYPE ${dt.name}`;
  if (dt.publicId) full += ` PUBLIC "${dt.publicId}"`;
  if (dt.systemId) full += `${dt.publicId ? "" : " SYSTEM"} "${dt.systemId}"`;
  return full + ">" + html.slice(short.length);
}
export { parseFragment };

export function isElement(node: T.Node): node is Element {
  return "tagName" in node;
}

/**
 * Every element under root in document order, template contents included. Collected up front,
 * so callers may remove or replace elements while iterating.
 */
export function allElements(root: ParentNode): Element[] {
  const out: Element[] = [];
  const stack: T.Node[] = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    out.push(node);
    const kids: T.Node[] = [...node.childNodes];
    if (node.tagName === "template" && "content" in node) kids.push(...(node as T.Template).content.childNodes);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

export function getAttr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name)?.value ?? null;
}

export function hasAttr(el: Element, name: string): boolean {
  return el.attrs.some((a) => a.name === name);
}

export function setAttr(el: Element, name: string, value: string): void {
  const a = el.attrs.find((x) => x.name === name);
  if (a) a.value = value;
  else el.attrs.push({ name, value });
}

export function removeAttr(el: Element, name: string): void {
  el.attrs = el.attrs.filter((a) => a.name !== name);
}

/** The space-separated tokens of an attribute, lower case (rel, for example). */
export function tokens(el: Element, name: string): string[] {
  return (getAttr(el, name) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

export function detach(node: ChildNode): void {
  if (node.parentNode) ta.detachNode(node);
}

export function replaceWith(node: ChildNode, replacement: ChildNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const i = parent.childNodes.indexOf(node);
  parent.childNodes[i] = replacement;
  replacement.parentNode = parent;
  node.parentNode = null;
}

export function createElement(tagName: string, attrs: Record<string, string> = {}): Element {
  return ta.createElement(
    tagName,
    html5.NS.HTML,
    Object.entries(attrs).map(([name, value]) => ({ name, value })),
  );
}

export function textOf(el: Element): string {
  return el.childNodes.map((n) => ("value" in n && n.nodeName === "#text" ? n.value : "")).join("");
}

export function setText(el: Element, text: string): void {
  for (const n of [...el.childNodes]) detach(n);
  ta.insertText(el, text);
}

/**
 * Sets a <style> element's CSS. parse5 writes style text raw, so a `</style` inside the CSS (in a
 * string or a comment) would end the element and let the rest parse as HTML, a <script> included.
 * `<\/style` is the same text to CSS (an escaped solidus) and cannot close the element.
 */
export function setStyleText(el: Element, css: string): void {
  setText(el, css.replace(/<\/(style)/gi, "<\\/$1"));
}

export function findFirst(root: ParentNode, test: (el: Element) => boolean): Element | null {
  return allElements(root).find(test) ?? null;
}
