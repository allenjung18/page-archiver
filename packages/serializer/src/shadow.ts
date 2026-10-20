// Open shadow roots are not part of outerHTML or importNode, so a web component's content would
// vanish from the archive. Each open root is written as a declarative shadow root, a
// <template shadowrootmode="open"> as the host's first child, which the HTML parser attaches as
// the host's shadow root when the archive opens (Chrome, Safari and Firefox). Closed roots cannot
// be read from the page and stay empty.

/** The live host's open shadow root, or null (none, or closed). */
export function openShadowRoot(el: Element): ShadowRoot | null {
  const root = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
  return root && root.mode === "open" ? root : null;
}

/**
 * An empty declarative-shadow-root <template> in `into` with the root's options. Its content is
 * filled by the caller (a deep copy of the root's children, then frozen like the rest).
 */
export function shadowTemplate(root: ShadowRoot, into: Document): HTMLTemplateElement {
  const t = into.createElement("template");
  t.setAttribute("shadowrootmode", "open");
  if (root.delegatesFocus) t.setAttribute("shadowrootdelegatesfocus", "");
  if ((root as ShadowRoot & { clonable?: boolean }).clonable) t.setAttribute("shadowrootclonable", "");
  if ((root as ShadowRoot & { serializable?: boolean }).serializable) t.setAttribute("shadowrootserializable", "");
  return t;
}
