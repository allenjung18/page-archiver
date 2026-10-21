// Stylesheets made self-contained: every @import replaced by the imported sheet (recursively,
// wrapped in its layer/supports/media conditions, with a cycle guard), and every url() and
// image-set() string replaced by a data: URI. Relative URLs resolve against the SHEET's own URL, never the page's: an
// @import chain two folders deep must still find its backgrounds. A data: sheet (a <link> or an
// @import of data:text/css) is decoded and made self-contained the same way; a relative URL in it
// names nothing, as it does live.
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
  /**
   * The document is in quirks mode (no standards doctype): a browser then applies a same-origin
   * sheet whatever its type, and a data: sheet is same-origin, so a `data:,…` sheet styles the page.
   */
  quirks?: boolean | undefined;
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

/** The bytes of a data: URL's body: base64, or percent-encoded (a malformed escape is kept as written). */
function dataBody(body: string, isBase64: boolean): Uint8Array {
  const bytes = new TextEncoder().encode(body);
  const decoded: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const hex = bytes[i] === 0x25 ? String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      decoded.push(parseInt(hex, 16));
      i += 2;
    } else decoded.push(bytes[i]!);
  }
  if (!isBase64) return Uint8Array.from(decoded);
  let b64 = "";
  // in pieces: one argument per byte would overflow the call stack on a sheet of a few hundred KB
  for (let i = 0; i < decoded.length; i += 0x8000) b64 += String.fromCharCode(...decoded.slice(i, i + 0x8000));
  b64 = b64.replace(/[\s=]/g, "");
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/**
 * The text of a data: URL stylesheet, or null when the value is not a data: URL of type text/css.
 * In a standards-mode page a browser applies a sheet only when it is text/css (a bare `data:,` is
 * text/plain), so any other type is left as it is: it styles nothing and asks nothing of the
 * network. `anyType` (a quirks-mode page, CssContext.quirks) takes a data: sheet of any type.
 */
export function dataCssText(value: string, anyType = false): string | null {
  const v = value.trim();
  const m = /^data:([^,]*),/i.exec(v);
  if (!m) return null;
  const params = (m[1] ?? "").split(";").map((p) => p.trim().toLowerCase());
  if (params[0] !== "text/css" && !anyType) return null;
  const isBase64 = params.length > 1 && params.at(-1) === "base64";
  let body = v.slice(m[0].length);
  const hash = body.indexOf("#");
  if (hash >= 0) body = body.slice(0, hash);
  return decode(dataBody(body, isBase64));
}

/** A sheet's URL as a warning names it: a data: URL cut short. */
export function sheetLabel(url: string): string {
  return /^data:/i.test(url) && url.length > 48 ? `${url.slice(0, 47)}…` : url;
}

/** True when a url() value is relative (no scheme, not a fragment): against a data: sheet it names nothing. */
function isRelativeRef(raw: string): boolean {
  const value = unescapeCss(raw.trim());
  return !!value && !value.startsWith("#") && !/^[a-z][a-z\d+.-]*:/i.test(value);
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

/**
 * The CSS identifier starting at text[i], its escapes decoded as the CSS tokenizer decodes them
 * (`\69 ` is "i", `\p` is "p"), and where it ends. Chromium reads an at-rule's name this way, so
 * "@\69mport" is an @import.
 */
function identAt(text: string, i: number): { name: string; end: number } {
  let name = "";
  let k = i;
  while (k < text.length) {
    const c = text[k]!;
    if (c === "\\") {
      const next = text[k + 1];
      if (next === "\n" || next === "\r" || next === "\f") break; // not an escape: the name ends
      if (next === undefined) return { name: name + "�", end: k + 1 };
      const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(k + 1, k + 7));
      if (hex) {
        const cp = parseInt(hex[0], 16);
        name += cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp);
        k += 1 + hex[0].length;
        // one whitespace ends a hex escape and is part of it (CR LF counts as one)
        if (text[k] === "\r" && text[k + 1] === "\n") k += 2;
        else if (/[ \t\n\r\f]/.test(text[k] ?? "")) k++;
      } else {
        const cp = text.codePointAt(k + 1)!;
        name += String.fromCodePoint(cp);
        k += cp > 0xffff ? 3 : 2;
      }
    } else if (/[\w-]/.test(c) || c.charCodeAt(0) >= 0x80) {
      name += c;
      k++;
    } else break;
  }
  return { name, end: k };
}

/** True when the at-keyword whose name starts at text[i] (just past its "@") is import, escapes decoded. */
function isImportAt(text: string, i: number): boolean {
  return identAt(text, i).name.toLowerCase() === "import";
}

/**
 * postcss ends an at-rule's name at a backslash, so `@i\6dport "x.css"` is an at-rule "i" with
 * params `\6dport "x.css"`; Chromium decodes the escapes and reads an @import. Such a rule is
 * renamed import here, so it is inlined, or set aside, as any @import is.
 */
function unescapeImportName(at: AtRule): void {
  if (at.raws.afterName !== "" || !at.params.startsWith("\\")) return;
  const raw = at.name + at.params;
  if (!isImportAt(raw, 0)) return;
  at.params = raw.slice(identAt(raw, 0).end).trim();
  at.name = "import";
  at.raws.afterName = " ";
}

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
      // in a data: sheet a relative URL fails live; left in the archive it would resolve against the file
      if (!url) return /^data:/i.test(base) && isRelativeRef(r.raw) ? UNFETCHED_URL : text.slice(r.index, r.index + r.length);
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

/** Where the quoted string or parenthesised group starting at text[i] ends (an unclosed one runs to the end). */
function groupEnd(text: string, i: number): number {
  if (text[i] !== "(") return stringAt(text, i)?.end ?? text.length;
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === '"' || c === "'") k = (stringAt(text, k)?.end ?? text.length) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k + 1;
  }
  return text.length;
}

/**
 * Every @import in CSS postcss could not parse, replaced by a comment naming its URL, as an
 * unfetched import is: written back as it came, the archive would fetch it, opened from disk.
 * Comments and strings are read past, so an "@import" inside one is left alone; a name written
 * with CSS escapes ("@\69mport", which postcss cannot parse) is decoded, as Chromium decodes it.
 */
function setImportsAside(css: string, sheetUrl: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === "/" && css[i + 1] === "*") i = commentEnd(css, i);
    else if (c === '"' || c === "'") i = stringAt(css, i)?.end ?? i + 1;
    else if (c === "\\") i += 2;
    else if (c === "@" && !IDENT_CHAR.test(css[i - 1] ?? "") && isImportAt(css, i + 1)) {
      // the name may be written with escapes ("@\69mport"), which Chromium decodes
      const nameEnd = identAt(css, i + 1).end;
      let end = nameEnd;
      while (end < css.length && css[end] !== ";" && css[end] !== "{" && css[end] !== "}") {
        if (css[end] === '"' || css[end] === "'" || css[end] === "(") end = groupEnd(css, end);
        else if (css[end] === "/" && css[end + 1] === "*") end = commentEnd(css, end);
        else end++;
      }
      const p = parseImport(css.slice(nameEnd, end));
      const url = p ? (resolveCssUrl(p.url, sheetUrl) ?? (/^\s*data:/i.test(p.url) ? sheetLabel(p.url.trim()) : null)) : null;
      if (css[end] === ";") end++;
      out += css.slice(last, i) + `/*${unfetchedNote("@import", url ?? "(not understood)")}*/`;
      last = i = end;
    } else i++;
  }
  return out + css.slice(last);
}

/**
 * The stylesheet `css`, fetched from (or written in a page at) `sheetUrl`, made self-contained.
 * `stack` is the chain of sheets importing this one; an @import back into it is a cycle and is
 * dropped, as browsers do.
 */
export async function inlineCss(css: string, sheetUrl: string, ctx: CssContext, stack: readonly string[] = []): Promise<string> {
  const label = sheetLabel(sheetUrl);
  let root: Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (err) {
    ctx.warn(`${label}: CSS did not parse (${(err as Error).message.split("\n")[0]}); url()s inlined, @import set aside`);
    return inlineUrls(setImportsAside(css, sheetUrl), sheetUrl, ctx);
  }

  const imports: AtRule[] = [];
  const faces: AtRule[] = [];
  root.walkAtRules((at) => {
    unescapeImportName(at);
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
    // an @import of a data:text/css sheet is decoded here; the sheet's own URL is the data: URL
    const data = p ? dataCssText(p.url, ctx.quirks) : null;
    const url = p ? (data !== null ? p.url.trim() : resolveCssUrl(p.url, sheetUrl)) : null;
    if (!p || !url) {
      ctx.warn(`${label}: @import ${sheetLabel(at.params)} not understood; dropped`);
      at.remove();
      continue;
    }
    if (chain.includes(url)) {
      ctx.warn(`${label}: @import ${sheetLabel(url)} is a cycle; dropped`);
      at.remove();
      continue;
    }
    if (chain.length > MAX_IMPORT_DEPTH) {
      ctx.warn(`${label}: @import ${sheetLabel(url)} nested deeper than ${MAX_IMPORT_DEPTH}; dropped`);
      at.remove();
      continue;
    }
    let text = data;
    if (text === null) {
      const res = await ctx.get(url);
      if (!res) {
        // the sheet fails to load either way; a comment keeps the record and asks nothing of the network
        at.replaceWith(postcss.comment({ text: unfetchedNote("@import", url).trim() }));
        continue;
      }
      text = decode(res.bytes);
    }
    const inner = await inlineCss(text, url, ctx, chain);
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
