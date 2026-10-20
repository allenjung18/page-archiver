// Stylesheets made self-contained: every @import replaced by the imported sheet (recursively,
// wrapped in its layer/supports/media conditions, with a cycle guard), and every url() and
// image-set() string replaced by a data: URI. Relative URLs resolve against the SHEET's own URL, never the page's: an
// @import chain two folders deep must still find its backgrounds.
import postcss, { type AtRule, type ChildNode, type Root } from "postcss";
import { utf8 } from "../bytes.ts";
import type { Resource } from "../resources.ts";
import { toDataUri } from "./datauri.ts";
import { pruneFontSrc, type FontFilter } from "./fonts.ts";

/** Where inlining gets bytes from (the capture's resolver), and where it reports. */
export interface CssContext {
  get(url: string): Promise<Resource | null>;
  warn(message: string): void;
  /** Which @font-face rules to keep (only faces the page loaded); every rule when absent. */
  fonts?: FontFilter | undefined;
  /** True when the browser fetched this URL while the page loaded (narrows a font's src list). */
  fetched?: ((url: string) => boolean) | undefined;
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

/** What a url() the capture could not have becomes: an empty data: URI, which fails as the fetch did and asks nothing of the network. */
export const UNFETCHED_URL = 'url("data:,")';

/** The text of a CSS comment saying where an unfetched resource was (a "*" + "/" in the URL cannot end the comment). */
export function unfetchedNote(what: string, url: string): string {
  return ` page-archiver unfetched${what ? ` ${what}` : ""}: ${url.replace(/\*\//g, "*%2F")} `;
}

/** A reference in a piece of CSS text: where it is, and the URL it names as written. */
export interface CssRef {
  index: number;
  length: number;
  raw: string;
}

/** Every url() token in text. */
export function urlTokens(text: string): CssRef[] {
  return [...text.matchAll(URL_TOKEN)].map((m) => ({ index: m.index, length: m[0].length, raw: m[1] ?? m[2] ?? m[3] ?? "" }));
}

/** True when CSS text may name a resource that inlining replaces: a url(), or a string in an image-set(). */
export function hasCssRefs(text: string): boolean {
  return /url\(|image-set\(/i.test(text);
}

const IMAGE_SET_AT = /(?:-webkit-)?image-set\(/iy;
const URL_AT = new RegExp(URL_TOKEN.source, "iy");
const IDENT_CHAR = /[\w\-\\]/;

/** The quoted string starting at text[i]: where it ends and what it holds as written; null when it is not closed on its line. */
function stringAt(text: string, i: number): { end: number; raw: string } | null {
  const quote = text[i];
  for (let k = i + 1; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === quote) return { end: k + 1, raw: text.slice(i + 1, k) };
    else if (c === "\n") return null;
  }
  return null;
}

/** Where the comment starting at text[i] ends. */
function commentEnd(text: string, i: number): number {
  const end = text.indexOf("*/", i + 2);
  return end < 0 ? text.length : end + 2;
}

/**
 * Reads the arguments of an image-set() from just after its "(", adding to `found` each option's
 * image written as a string ("a.png" 1x) rather than a url(). Returns where the function ends.
 */
function scanImageSet(text: string, from: number, found: CssRef[]): number {
  let depth = 0;
  let atOption = true;
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = commentEnd(text, i);
    } else if (c === '"' || c === "'") {
      const s = stringAt(text, i);
      if (!s) return text.length; // a bad string: the rest of the value is not read as CSS
      // only the image of an option: a string in type() or another function is not a URL
      if (depth === 0 && atOption) found.push({ index: i, length: s.end - i, raw: s.raw });
      atOption = false;
      i = s.end;
    } else if (c === "\\") {
      atOption = false;
      i += 2;
    } else {
      atOption = false;
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) return i + 1;
        depth--;
      } else if (c === "," && depth === 0) atOption = true;
      i++;
    }
  }
  return i;
}

/**
 * The string arguments of every image-set() and -webkit-image-set() in text, which the browser
 * fetches as it does a url(). A string anywhere else (a type(), a comment, a `content` value) is not one.
 */
export function imageSetStrings(text: string): CssRef[] {
  const found: CssRef[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const boundary = !IDENT_CHAR.test(text[i - 1] ?? "");
    URL_AT.lastIndex = i;
    IMAGE_SET_AT.lastIndex = i;
    if (c === "/" && text[i + 1] === "*") i = commentEnd(text, i);
    else if (c === '"' || c === "'") i = stringAt(text, i)?.end ?? i + 1;
    else if (c === "\\") i += 2;
    else if (boundary && URL_AT.test(text)) i = URL_AT.lastIndex;
    else if (boundary && IMAGE_SET_AT.test(text)) i = scanImageSet(text, IMAGE_SET_AT.lastIndex, found);
    else i++;
  }
  return found;
}

/**
 * Replaces every url() in a piece of CSS text (a declaration value, a style attribute), and every
 * string argument of an image-set(), with a data: URI of the resource it names. A resource that
 * cannot be had becomes UNFETCHED_URL, followed by a comment with its absolute URL, so the archive
 * still says where it was; or, given `unfetched`, what that returns for its URL and its place in text.
 */
export async function inlineUrls(
  text: string,
  base: string,
  ctx: CssContext,
  unfetched: (url: string, index: number) => string = (url) => `${UNFETCHED_URL} /*${unfetchedNote("", url)}*/`,
): Promise<string> {
  if (!hasCssRefs(text)) return text;
  const all = [...urlTokens(text), ...(/image-set\(/i.test(text) ? imageSetStrings(text) : [])].sort((a, b) => a.index - b.index);
  // a "url(" written inside an image-set() string is part of that string, not a url() of its own
  const refs: CssRef[] = [];
  for (const r of all) {
    const prev = refs.at(-1);
    if (!prev || r.index >= prev.index + prev.length) refs.push(r);
  }
  const replacements = await Promise.all(
    refs.map(async (r) => {
      const url = resolveCssUrl(r.raw, base);
      if (!url) return text.slice(r.index, r.index + r.length);
      const res = await ctx.get(url);
      return res ? `url("${toDataUri(res.bytes, res.mime)}")` : unfetched(url, r.index);
    }),
  );
  let out = "";
  let last = 0;
  refs.forEach((r, i) => {
    out += text.slice(last, r.index) + replacements[i];
    last = r.index + r.length;
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

function decode(bytes: Uint8Array): string {
  const text = utf8(bytes);
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
  const faces: AtRule[] = [];
  root.walkAtRules((at) => {
    const name = at.name.toLowerCase();
    if (name === "charset") at.remove();
    else if (name === "import") imports.push(at);
    else if (name === "font-face") faces.push(at);
  });
  for (const face of faces) {
    if (ctx.fonts?.decide(face) === "drop") {
      face.remove();
      continue;
    }
    const fetched = ctx.fetched;
    if (!fetched) continue;
    face.walkDecls(/^src$/i, (decl) => {
      decl.value = pruneFontSrc(decl.value, (entry) => {
        const m = new RegExp(URL_TOKEN.source, "i").exec(entry);
        const url = m ? resolveCssUrl(m[1] ?? m[2] ?? m[3] ?? "", sheetUrl) : null;
        return !!url && fetched(url);
      });
    });
  }

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
      // the sheet fails to load either way; a comment keeps the record and asks nothing of the network
      at.replaceWith(postcss.comment({ text: unfetchedNote("@import", url).trim() }));
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
    if (hasCssRefs(decl.value)) {
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
