// Stylesheets made self-contained: every @import replaced by the imported sheet (recursively,
// wrapped in its layer/supports/media conditions, with a cycle guard), and every url() replaced
// by a data: URI. Relative URLs resolve against the SHEET's own URL, never the page's: an
// @import chain two folders deep must still find its backgrounds.
import postcss, { type AtRule, type ChildNode, type Root } from "postcss";
import type { Resource } from "../resources.ts";
import { toDataUri } from "./datauri.ts";

/** Where inlining gets bytes from (the capture's resolver), and where it reports. */
export interface CssContext {
  get(url: string): Promise<Resource | null>;
  warn(message: string): void;
}

/** @import nesting deeper than this is dropped with a warning. */
export const MAX_IMPORT_DEPTH = 16;

// url( "…" | '…' | bare ) — CSS escapes inside are kept as written and unescaped on use.
const URL_TOKEN = /url\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|((?:[^)\s"'\\]|\\.)*))\s*\)/gi;

function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, "$1");
}

/** An absolute URL for a url() value, or null for values that are not fetched (data:, #id, empty). */
export function resolveCssUrl(raw: string, base: string): string | null {
  const value = unescapeCss(raw.trim());
  if (!value || value.startsWith("#")) return null;
  if (/^(data|about|blob|javascript):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Replaces every url() in a piece of CSS text (a declaration value, a style attribute) with a
 * data: URI of the resource it names. A resource that cannot be had keeps its URL, made
 * absolute, so the archive still says where it was.
 */
export async function inlineUrls(text: string, base: string, ctx: CssContext): Promise<string> {
  if (!/url\(/i.test(text)) return text;
  const matches = [...text.matchAll(URL_TOKEN)];
  const replacements = await Promise.all(
    matches.map(async (m) => {
      const raw = m[1] ?? m[2] ?? m[3] ?? "";
      const url = resolveCssUrl(raw, base);
      if (!url) return m[0];
      const res = await ctx.get(url);
      return `url("${res ? toDataUri(res.bytes, res.mime) : url.replace(/["\\\n]/g, (c) => `\\${c === "\n" ? "a " : c}`)}")`;
    }),
  );
  let out = "";
  let last = 0;
  matches.forEach((m, i) => {
    out += text.slice(last, m.index) + replacements[i];
    last = m.index + m[0].length;
  });
  return out + text.slice(last);
}

interface ImportParams {
  url: string;
  layer: string | null; // null: no layer; "": anonymous layer
  supports: string | null;
  media: string;
}

/** Splits `@import` params into the URL and its layer(), supports() and media conditions. */
export function parseImport(params: string): ImportParams | null {
  let rest = params.trim();
  let raw: string;
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(rest);
  if (quoted) {
    raw = quoted[1] ?? quoted[2] ?? "";
    rest = rest.slice(quoted[0].length);
  } else {
    URL_TOKEN.lastIndex = 0;
    const u = new RegExp(`^${URL_TOKEN.source}`, "i").exec(rest);
    if (!u) return null;
    raw = u[1] ?? u[2] ?? u[3] ?? "";
    rest = rest.slice(u[0].length);
  }
  rest = rest.trim();
  let layer: string | null = null;
  const layerMatch = /^layer(?:\(\s*([^)]*?)\s*\))?(?=\s|$|supports\()/i.exec(rest);
  if (layerMatch) {
    layer = layerMatch[1] ?? "";
    rest = rest.slice(layerMatch[0].length).trim();
  }
  let supports: string | null = null;
  if (/^supports\(/i.test(rest)) {
    let depth = 0;
    let i = "supports".length;
    for (; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")" && --depth === 0) break;
    }
    supports = rest.slice("supports(".length, i).trim();
    rest = rest.slice(i + 1).trim();
  }
  return { url: unescapeCss(raw), layer, supports, media: rest };
}

function wrap(nodes: ChildNode[], p: ImportParams): ChildNode[] {
  let inner = nodes;
  const box = (name: string, params: string) => {
    const at = postcss.atRule({ name, params });
    at.append(...inner);
    inner = [at];
  };
  if (p.media && p.media.toLowerCase() !== "all") box("media", p.media);
  if (p.supports !== null) box("supports", `(${p.supports})`);
  if (p.layer !== null) box("layer", p.layer);
  return inner;
}

function decode(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The stylesheet `css`, fetched from (or written in a page at) `sheetUrl`, made self-contained.
 * `stack` is the chain of sheets importing this one; an @import back into it is a cycle and is
 * dropped, as browsers do.
 */
export async function inlineCss(css: string, sheetUrl: string, ctx: CssContext, stack: readonly string[] = []): Promise<string> {
  let root: Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (err) {
    ctx.warn(`${sheetUrl}: CSS did not parse (${(err as Error).message.split("\n")[0]}); url()s inlined, @import left as is`);
    return inlineUrls(css, sheetUrl, ctx);
  }

  const imports: AtRule[] = [];
  root.walkAtRules((at) => {
    const name = at.name.toLowerCase();
    if (name === "charset") at.remove();
    else if (name === "import") imports.push(at);
  });

  const chain = [...stack, sheetUrl];
  for (const at of imports) {
    const p = parseImport(at.params);
    const url = p ? resolveCssUrl(p.url, sheetUrl) : null;
    if (!p || !url) {
      ctx.warn(`${sheetUrl}: @import ${at.params} not understood; dropped`);
      at.remove();
      continue;
    }
    if (chain.includes(url)) {
      ctx.warn(`${sheetUrl}: @import ${url} is a cycle; dropped`);
      at.remove();
      continue;
    }
    if (chain.length > MAX_IMPORT_DEPTH) {
      ctx.warn(`${sheetUrl}: @import ${url} nested deeper than ${MAX_IMPORT_DEPTH}; dropped`);
      at.remove();
      continue;
    }
    const res = await ctx.get(url);
    if (!res) {
      // keep it pointing at the network, absolute: the archive's CSP refuses it, the record survives
      at.params = `url("${url}")${p.layer !== null ? ` layer${p.layer ? `(${p.layer})` : ""}` : ""}${p.supports !== null ? ` supports(${p.supports})` : ""}${p.media ? ` ${p.media}` : ""}`;
      continue;
    }
    const inner = await inlineCss(decode(res.bytes), url, ctx, chain);
    let parsed: Root;
    try {
      parsed = postcss.parse(inner, { from: undefined });
    } catch {
      at.remove();
      continue;
    }
    at.replaceWith(...wrap(parsed.nodes.slice(), p));
  }

  const decls: Promise<void>[] = [];
  root.walkDecls((decl) => {
    if (/url\(/i.test(decl.value)) {
      decls.push(
        inlineUrls(decl.value, sheetUrl, ctx).then((v) => {
          decl.value = v;
        }),
      );
    }
  });
  await Promise.all(decls);
  return root.toString();
}

/** Decodes a stylesheet's bytes (UTF-8, BOM dropped). */
export { decode as decodeCss };
