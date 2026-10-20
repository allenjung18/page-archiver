// Small helpers over parse5's default tree: the archive is assembled as a parse5 document in
// Node, never in a browser DOM.
import { defaultTreeAdapter as ta, html as html5, parse, parseFragment, serialize, type DefaultTreeAdapterTypes as T } from "parse5";

export type Document = T.Document;
export type Element = T.Element;
export type ParentNode = T.ParentNode;
export type ChildNode = T.ChildNode;

export const parseDocument = (source: string): Document => parse(source);
export const serializeDocument = (doc: Document | T.DocumentFragment): string => serialize(doc);
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

export function findFirst(root: ParentNode, test: (el: Element) => boolean): Element | null {
  return allElements(root).find(test) ?? null;
}
