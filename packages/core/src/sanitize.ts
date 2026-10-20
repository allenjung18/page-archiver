// Everything that could run, navigate, or reach the network on its own is removed from the
// archive. A frozen page needs no JavaScript: what it rendered is already in the DOM.
import { allElements, detach, getAttr, parseDocument, removeAttr, serializeDocument, tokens, type Document, type Element } from "./dom.ts";

/** Elements removed outright, wherever they are (SVG <script> included). */
export const REMOVED_ELEMENTS = ["script", "noscript", "base"] as const;

/** <meta http-equiv> values removed: the page's own CSP, and timed navigation. */
export const REMOVED_META_HTTP_EQUIV = ["content-security-policy", "content-security-policy-report-only", "refresh"] as const;

/** <link rel> tokens whose link is removed: hints that fetch, and the web app manifest. */
export const REMOVED_LINK_RELS = ["preload", "prefetch", "modulepreload", "preconnect", "dns-prefetch", "prerender", "manifest", "serviceworker"] as const;

/** Attributes whose value is a URL that could be javascript:. */
export const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "poster", "background", "cite", "data", "codebase", "xlink:href"] as const;

/** SVG animation attributes that can set a URL attribute to javascript:. */
const ANIMATION_VALUE_ATTRIBUTES = ["to", "from", "values", "by"] as const;

/**
 * Elements whose URL attribute loads a whole document: a data: URL there (text/html, SVG…) can
 * carry script, so it is removed. Frames come back as sanitized srcdoc in a later step.
 */
export const DOCUMENT_URL_ATTRIBUTES: Record<string, readonly string[]> = {
  iframe: ["src"],
  frame: ["src"],
  embed: ["src"],
  object: ["data"],
};

/** Attributes that make a request on their own, removed always. */
export const REMOVED_ATTRIBUTES = ["ping"] as const;

export interface SanitizeReport {
  elements: number;
  attributes: number;
}

/** True when a browser would run this URL as script (whitespace and controls are ignored). */
export function isScriptUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^(javascript|vbscript):/i.test(value.replace(/[\u0000- \u007f]/g, ""));
}

function attrName(a: { name: string; prefix?: string }): string {
  return a.prefix ? `${a.prefix}:${a.name}` : a.name;
}

function shouldRemoveElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if ((REMOVED_ELEMENTS as readonly string[]).includes(tag)) return true;
  if (tag === "meta") {
    const equiv = (getAttr(el, "http-equiv") ?? "").trim().toLowerCase();
    return (REMOVED_META_HTTP_EQUIV as readonly string[]).includes(equiv);
  }
  if (tag === "link") return tokens(el, "rel").some((r) => (REMOVED_LINK_RELS as readonly string[]).includes(r));
  return false;
}

/** Removes scripts and script hooks from doc in place. */
export function sanitizeDocument(doc: Document | Element): SanitizeReport {
  const report: SanitizeReport = { elements: 0, attributes: 0 };
  for (const el of allElements(doc)) {
    if (!el.parentNode) continue; // inside something already removed
    if (shouldRemoveElement(el)) {
      detach(el);
      report.elements++;
      continue;
    }
    const before = el.attrs.length;
    const animates = ["set", "animate"].includes(el.tagName);
    const documentUrls = DOCUMENT_URL_ATTRIBUTES[el.tagName.toLowerCase()] ?? [];
    el.attrs = el.attrs.filter((a) => {
      const name = attrName(a).toLowerCase();
      if (name.startsWith("on")) return false;
      if ((REMOVED_ATTRIBUTES as readonly string[]).includes(name)) return false;
      if ((URL_ATTRIBUTES as readonly string[]).includes(name) && isScriptUrl(a.value)) return false;
      // eslint-disable-next-line no-control-regex
      if (documentUrls.includes(name) && /^data:/i.test(a.value.replace(/[\u0000-\u0020\u007f]/g, ""))) return false;
      if (animates && (ANIMATION_VALUE_ATTRIBUTES as readonly string[]).includes(name) && /(javascript|vbscript):/i.test(a.value.replace(/\s/g, ""))) return false;
      return true;
    });
    report.attributes += before - el.attrs.length;
    const srcdoc = getAttr(el, "srcdoc");
    if (srcdoc !== null) {
      const inner = parseDocument(srcdoc);
      const r = sanitizeDocument(inner);
      report.elements += r.elements;
      report.attributes += r.attributes;
      removeAttr(el, "srcdoc");
      el.attrs.push({ name: "srcdoc", value: serializeDocument(inner) });
    }
  }
  return report;
}

/** sanitizeDocument over an HTML string. */
export function sanitizeHtml(html: string): string {
  const doc = parseDocument(html);
  sanitizeDocument(doc);
  return serializeDocument(doc);
}
