// The reader copy: Mozilla Readability run over the frozen archive (scripts already gone, images
// already data: URIs), written as reader.html, a plain page of the article's text and images
// that is as self-contained as the archive itself.
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { allElements, detach, parseDocument, serializeDocument, tokens } from "../dom.ts";
import { sanitizeHtml } from "../sanitize.ts";

/** The file name of the reader copy inside a capture's folder. */
export const READER_FILE = "reader.html";

export interface ReaderView {
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  lang: string | null;
  dir: string | null;
  publishedTime: string | null;
  /** The article as Readability cleaned it: an HTML fragment. */
  content: string;
  /** The article's text, tags removed (what the library indexes). */
  textContent: string;
}

/** Elements Readability would drop anyway, removed before jsdom has to parse their CSS. */
function stripForReader(html: string): string {
  const doc = parseDocument(html);
  for (const el of allElements(doc)) {
    if (el.tagName === "style" || el.tagName === "template" || (el.tagName === "link" && tokens(el, "rel").includes("stylesheet"))) detach(el);
  }
  return serializeDocument(doc);
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t : null;
};

/**
 * Readability over an archive's HTML. `url` is the page's address (relative links resolve
 * against it). Null when Readability finds no article in the page.
 */
export function extractReader(html: string, url: string): ReaderView | null {
  // jsdom never runs the page's scripts or loads its resources unless told to; its console
  // (CSS it cannot parse, and the like) goes nowhere
  const dom = new JSDOM(stripForReader(html), { url, virtualConsole: new VirtualConsole() });
  try {
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) return null;
    const title = clean(article.title) ?? clean(dom.window.document.title);
    return {
      title: title ?? url,
      byline: clean(article.byline),
      siteName: clean(article.siteName),
      excerpt: clean(article.excerpt),
      lang: clean(article.lang),
      dir: clean(article.dir),
      publishedTime: clean(article.publishedTime),
      content: article.content,
      textContent: (article.textContent ?? "").trim(),
    };
  } finally {
    dom.window.close();
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** Typography for the reader copy; light and dark follow the reader's system setting. */
export const READER_CSS = `
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d1b16; --muted: #6b6455; --rule: #e2ddd0; --link: #1f5fa8; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #e8e6e1; --muted: #a29d92; --rule: #33322f; --link: #8fbaf0; } }
html { background: var(--bg); color: var(--fg); }
body { margin: 0; padding: 40px 20px 80px; font: 19px/1.65 Georgia, "Times New Roman", serif; }
.pa-reader { max-width: 680px; margin: 0 auto; }
.pa-reader header { border-bottom: 1px solid var(--rule); margin-bottom: 28px; padding-bottom: 16px; }
.pa-site, .pa-byline, .pa-source { font: 14px/1.4 system-ui, -apple-system, sans-serif; color: var(--muted); margin: 6px 0; }
.pa-reader h1 { font-size: 36px; line-height: 1.2; margin: 8px 0 12px; }
.pa-content img, .pa-content video, .pa-content svg { max-width: 100%; height: auto; }
.pa-content figure { margin: 28px 0; }
.pa-content figcaption { font-size: 15px; color: var(--muted); }
.pa-content blockquote { margin: 24px 0; padding-left: 18px; border-left: 3px solid var(--rule); font-style: italic; }
.pa-content pre { overflow-x: auto; font-size: 15px; }
.pa-content table { border-collapse: collapse; }
.pa-content td, .pa-content th { border: 1px solid var(--rule); padding: 4px 8px; }
a { color: var(--link); }
`.trim();

export interface ReaderPageInfo {
  /** The page's address, linked from the header. */
  url: string;
  capturedAt: Date;
}

/** reader.html: the article in a plain, script-free page with the reader stylesheet. */
export function renderReader(view: ReaderView, info: ReaderPageInfo): string {
  const attrs = [view.lang ? ` lang="${esc(view.lang)}"` : "", view.dir ? ` dir="${esc(view.dir)}"` : ""].join("");
  const when = info.capturedAt.toISOString();
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="page-archiver:source-url" content="${esc(info.url)}">`,
    `<meta name="page-archiver:captured-at" content="${esc(when)}">`,
    `<title>${esc(view.title)}</title>`,
    `<style>${READER_CSS}</style>`,
  ].join("\n");
  const header = [
    view.siteName ? `<p class="pa-site">${esc(view.siteName)}</p>` : "",
    `<h1>${esc(view.title)}</h1>`,
    view.byline ? `<p class="pa-byline">${esc(view.byline)}</p>` : "",
    `<p class="pa-source"><a href="${esc(info.url)}">${esc(info.url)}</a> &middot; saved <time datetime="${esc(when)}">${esc(when.slice(0, 10))}</time></p>`,
  ].filter(Boolean).join("\n");
  const page = `<!doctype html>\n<html${attrs}>\n<head>\n${head}\n</head>\n<body>\n<article class="pa-reader">\n<header>\n${header}\n</header>\n<div class="pa-content">\n${view.content}\n</div>\n</article>\n</body>\n</html>\n`;
  // the content came from a sanitized archive; sanitizing the finished page again costs little
  return sanitizeHtml(page);
}
