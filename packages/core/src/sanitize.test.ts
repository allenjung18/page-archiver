// The sanitizer table: attribute by attribute and element by element, what is stripped and what
// stays. A row added here is a rule; a row changed here is a decision.
import { describe, expect, it } from "vitest";
import { allElements, getAttr, parseDocument, serializeDocument } from "./dom.ts";
import { isScriptUrl, sanitizeDocument, sanitizeHtml } from "./sanitize.ts";

type AttrRow = [element: string, attribute: string, value: string, kept: boolean];

const ATTRIBUTES: AttrRow[] = [
  // event handlers: every on* goes, whatever the element or case
  ["div", "onclick", "alert(1)", false],
  ["body", "onload", "init()", false],
  ["img", "onerror", "x()", false],
  ["a", "onmouseover", "x()", false],
  ["svg", "onload", "x()", false],
  ["div", "ONCLICK", "x()", false],
  ["div", "onanimationstart", "x()", false],
  // javascript: and vbscript: URLs go, however they are disguised
  ["a", "href", "javascript:alert(1)", false],
  ["a", "href", "JavaScript:alert(1)", false],
  ["a", "href", "  javascript:alert(1)", false],
  ["a", "href", "java\tscript:alert(1)", false],
  ["a", "href", "java\nscript:alert(1)", false],
  ["a", "href", "vbscript:msgbox", false],
  ["iframe", "src", "javascript:parent.x()", false],
  ["form", "action", "javascript:x()", false],
  ["button", "formaction", "javascript:x()", false],
  ["video", "poster", "javascript:x()", false],
  ["blockquote", "cite", "javascript:x()", false],
  ["object", "data", "javascript:x()", false],
  ["a", "ping", "https://tracker.example/p", false],
  // an attribution request, made on load (an <img>) or on a click (an <a>), from any secure context
  ["img", "attributionsrc", "https://tracker.example/a", false],
  ["img", "attributionsrc", "", false],
  ["a", "attributionsrc", "https://tracker.example/a", false],
  ["img", "ATTRIBUTIONSRC", "https://tracker.example/a", false],
  // a data: document in a frame or plugin can carry script
  ["iframe", "src", "data:text/html,<script>alert(1)</script>", false],
  ["iframe", "src", " DATA:text/html;base64,PHNjcmlwdD4=", false],
  ["embed", "src", "data:image/svg+xml,<svg onload='x()'/>", false],
  ["object", "data", "data:text/html;base64,PHNjcmlwdD4=", false],
  // ordinary URLs and everything else stay
  ["a", "href", "https://example.com/page", true],
  ["a", "href", "#section-2", true],
  ["a", "href", "mailto:someone@example.com", true],
  ["a", "href", "/relative/page", true],
  ["a", "href", "javascript-guide.html", true],
  ["img", "src", "data:image/png;base64,AAAA", true],
  ["img", "src", "data:image/svg+xml,<svg/>", true],
  ["iframe", "src", "https://example.com/embed", true],
  ["object", "data", "https://example.com/movie.swf", true],
  ["form", "action", "https://example.com/search", true],
  ["div", "class", "on-sale", true],
  ["div", "data-onclick", "x()", true],
  ["div", "style", "color: red", true],
  ["img", "alt", "javascript:in alt text is just text", true],
  ["div", "title", "onclick", true],
  ["a", "target", "_blank", true],
  ["input", "value", "javascript:typed by the user", true],
];

describe("sanitizer: attributes", () => {
  for (const [element, attribute, value, kept] of ATTRIBUTES) {
    it(`<${element} ${attribute}="${value.replace(/\s/g, (c) => JSON.stringify(c).slice(1, -1))}"> ${kept ? "stays" : "is stripped"}`, () => {
      const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;");
      const doc = parseDocument(`<!doctype html><body><${element} id="t" ${attribute}="${escaped}"></${element}>`);
      sanitizeDocument(doc);
      const el = allElements(doc).find((e) => getAttr(e, "id") === "t");
      expect(el, "the element itself stays").toBeDefined();
      expect(getAttr(el!, attribute.toLowerCase()), attribute).toBe(kept ? value : null);
    });
  }

  it("strips xlink:href javascript: in SVG, keeps an ordinary one", () => {
    const out = sanitizeHtml(
      `<svg><a id="bad" xlink:href="javascript:x()"><text>x</text></a><a id="ok" xlink:href="#n"><text>y</text></a></svg>`,
    );
    expect(out).not.toContain("javascript:");
    expect(out).toContain(`xlink:href="#n"`);
  });

  it("strips an SVG <set>/<animate> that would write a javascript: URL", () => {
    const out = sanitizeHtml(`<svg><a><set attributeName="href" to="javascript:x()"/><animate attributeName="href" values="#a;javascript:x()"/><animate attributeName="x" to="10"/></a></svg>`);
    expect(out).not.toContain("javascript:");
    expect(out).toContain(`to="10"`);
  });
});

type ElementRow = [html: string, removed: boolean];

const ELEMENTS: ElementRow[] = [
  [`<script>alert(1)</script>`, true],
  [`<script src="https://cdn.example/app.js"></script>`, true],
  [`<script type="application/ld+json">{"@type":"Article"}</script>`, true],
  [`<script type="module">import "x"</script>`, true],
  [`<noscript><img src="https://t.example/pixel.gif"></noscript>`, true],
  [`<base href="https://example.com/">`, true],
  [`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`, true],
  [`<meta http-equiv="content-security-policy-report-only" content="default-src 'self'">`, true],
  [`<meta http-equiv="refresh" content="0;url=https://example.com/">`, true],
  [`<link rel="preload" href="https://cdn.example/font.woff2" as="font">`, true],
  [`<link rel="prefetch" href="/next.html">`, true],
  [`<link rel="modulepreload" href="/app.js">`, true],
  [`<link rel="preconnect" href="https://cdn.example">`, true],
  [`<link rel="dns-prefetch" href="//cdn.example">`, true],
  [`<link rel="prerender" href="/next.html">`, true],
  [`<link rel="manifest" href="/site.webmanifest">`, true],
  [`<link rel="serviceworker" href="/sw.js">`, true],
  [`<link rel="compression-dictionary" href="https://ads.example/dict/gpt">`, true],
  [`<link rel="dictionary" href="/dict">`, true],
  [`<link rel="stylesheet" href="https://cdn.example/site.css">`, false],
  [`<link rel="canonical" href="https://example.com/a">`, false],
  [`<link rel="icon" href="data:image/png;base64,AAAA">`, false],
  [`<meta charset="utf-8">`, false],
  [`<meta name="viewport" content="width=device-width">`, false],
  [`<meta name="description" content="A page">`, false],
  [`<style>p{color:red}</style>`, false],
  [`<iframe srcdoc="<p>x</p>"></iframe>`, false],
  [`<template><p>t</p></template>`, false],
  [`<form action="https://example.com/s"><input name="q"></form>`, false],
];

describe("sanitizer: elements", () => {
  for (const [html, removed] of ELEMENTS) {
    it(`${html} ${removed ? "is removed" : "stays"}`, () => {
      const tag = /^<([a-z]+)/.exec(html)![1]!;
      const doc = parseDocument(`<!doctype html><html><head>${html}</head><body><p id="keep">k</p>${html}</body></html>`);
      sanitizeDocument(doc);
      const left = allElements(doc).filter((e) => e.tagName === tag);
      if (removed) expect(left, serializeDocument(doc)).toEqual([]);
      else expect(left.length, serializeDocument(doc)).toBeGreaterThan(0);
      expect(allElements(doc).some((e) => getAttr(e, "id") === "keep")).toBe(true);
    });
  }

  it("strips a data: document from a <frame> in a frameset, keeps an ordinary one", () => {
    const out = sanitizeHtml(`<frameset><frame src="data:text/html,<script>x()</script>"><frame src="https://example.com/nav"></frameset>`);
    expect(out).not.toContain("data:");
    expect(out).toContain(`<frame src="https://example.com/nav">`);
  });

  it("removes an SVG <script>", () => {
    expect(sanitizeHtml(`<svg><script>alert(1)</script><circle r="1"/></svg>`)).not.toContain("script");
  });

  it("sanitizes inside <template> content", () => {
    const out = sanitizeHtml(`<template><script>x()</script><b onclick="y()">t</b></template>`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("<b>t</b>");
  });

  it("sanitizes an iframe's srcdoc, recursively", () => {
    const out = sanitizeHtml(`<iframe srcdoc="<p onclick=&quot;x()&quot;>in</p><script>y()</script>"></iframe>`);
    const doc = parseDocument(out);
    const srcdoc = getAttr(allElements(doc).find((e) => e.tagName === "iframe")!, "srcdoc")!;
    expect(srcdoc).toContain("<p>in</p>");
    expect(srcdoc).not.toMatch(/script|onclick/);
  });

  it("reports what it removed", () => {
    const doc = parseDocument(`<script></script><div onclick="x" onload="y"><a href="javascript:z">a</a></div>`);
    expect(sanitizeDocument(doc)).toEqual({ elements: 1, attributes: 3 });
  });

  it("is idempotent", () => {
    const once = sanitizeHtml(`<div onclick="x"><script>1</script><a href="javascript:2">a</a></div>`);
    expect(sanitizeHtml(once)).toBe(once);
  });
});

describe("isScriptUrl", () => {
  it("sees through controls and whitespace", () => {
    expect(isScriptUrl("\u0001javascript:x")).toBe(true);
    expect(isScriptUrl("jav\u0000ascript:x")).toBe(true);
    expect(isScriptUrl("https://example.com/javascript:x")).toBe(false);
  });
});
