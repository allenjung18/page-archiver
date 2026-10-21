// Stylesheets made self-contained: every @import replaced by the imported sheet (recursively,
// wrapped in its layer/supports/media conditions, with a cycle guard), and every url() and
// image-set() string replaced by a data: URI. Relative URLs resolve against the SHEET's own URL, never the page's: an
// @import chain two folders deep must still find its backgrounds. A data: sheet (a <link> or an
// @import of data:text/css) is decoded and made self-contained the same way; a relative URL in it
// names nothing, as it does live.
import postcss, { type AtRule, type ChildNode, type Declaration, type Root } from "postcss";
import { utf8 } from "../bytes.ts";
import type { Resource } from "../resources.ts";
import { effectiveMime, toDataUri } from "./datauri.ts";
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
   * True when the browser asked for this URL while the page loaded, whatever the answer (an HTTP
   * error too): a custom property's string it asked for and could not have is set aside. `fetched`
   * stands in when absent.
   */
  requested?: ((url: string) => boolean) | undefined;
  /**
   * The document is in quirks mode (no standards doctype): a browser then applies a same-origin
   * sheet whatever its type, and a data: sheet is same-origin, so a `data:,…` sheet styles the page.
   */
  quirks?: boolean | undefined;
}

/** @import nesting deeper than this is dropped with a warning. */
export const MAX_IMPORT_DEPTH = 16;

// url()s and strings are read as the CSS tokenizer (CSS Syntax 3, section 4) reads them, which is
// how Chromium reads them: the end of the text closes an open url( or string, a backslash before a
// newline in a string is a line continuation, comments are skipped between tokens, and only space,
// tab and the newlines are whitespace (a no-break space is part of an unquoted url()).

/** True when c is CSS whitespace: space, tab, LF, CR or FF. JS's \s also takes U+00A0 and U+3000, which CSS does not. */
function isCssSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/** True when c is a CSS newline (LF, CR or FF; the tokenizer reads CR LF as one). */
function isNewline(c: string | undefined): boolean {
  return c === "\n" || c === "\r" || c === "\f";
}

/** Where the whitespace and comments starting at text[i] end. */
function skipSpaceAndComments(text: string, i: number): number {
  for (;;) {
    while (isCssSpace(text[i])) i++;
    if (text[i] === "/" && text[i + 1] === "*") i = commentEnd(text, i);
    else return i;
  }
}

/**
 * The escape whose backslash is text[k] (one not followed by a newline): the character it stands
 * for and where it ends. A hex escape takes up to six digits and one whitespace after them (CR LF
 * counts as one); a code point of 0, a surrogate or one past U+10FFFF is U+FFFD, as is a backslash
 * at the end of the text.
 */
function escapeAt(text: string, k: number): { value: string; end: number } {
  if (k + 1 >= text.length) return { value: "\uFFFD", end: k + 1 };
  const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(k + 1, k + 7));
  if (hex) {
    const cp = parseInt(hex[0], 16);
    let end = k + 1 + hex[0].length;
    if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
    else if (isCssSpace(text[end])) end++;
    return { value: cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(cp), end };
  }
  const cp = text.codePointAt(k + 1)!;
  return { value: String.fromCodePoint(cp), end: k + 1 + (cp > 0xffff ? 2 : 1) };
}

/** Where a string's backslash at text[k] and what it escapes end: a newline after it (CR LF too) is a line continuation. */
function stringEscapeEnd(text: string, k: number): number {
  const next = text[k + 1];
  if (next === undefined) return k + 1;
  if (next === "\r" && text[k + 2] === "\n") return k + 3;
  if (isNewline(next)) return k + 2;
  return escapeAt(text, k).end;
}

/** A url() value or string as written, its escapes decoded: a backslash before a newline (a line continuation) or at the end stands for nothing. */
function unescapeCss(s: string): string {
  if (!s.includes("\\")) return s;
  let out = "";
  let k = 0;
  while (k < s.length) {
    if (s[k] !== "\\") {
      out += s[k];
      k++;
    } else if (k + 1 >= s.length || isNewline(s[k + 1])) {
      k = stringEscapeEnd(s, k);
    } else {
      const e = escapeAt(s, k);
      out += e.value;
      k = e.end;
    }
  }
  return out;
}

/** A URL with what the URL parser strips from its ends (C0 controls and space) stripped; a no-break space is kept, as it is. */
function trimUrl(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/** An absolute URL for a url() value, or null for values that are not fetched (data:, #id, empty). */
export function resolveCssUrl(raw: string, base: string): string | null {
  const value = trimUrl(unescapeCss(raw));
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
  const value = trimUrl(unescapeCss(raw));
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

/** True when c can be part of a CSS name: a letter, digit, "_", "-", a non-ASCII character, or the backslash of an escape. */
function isNameChar(c: string | undefined): boolean {
  return c !== undefined && (/[\w\-\\]/.test(c) || c.charCodeAt(0) >= 0x80);
}

/**
 * The function whose name starts at text[i] (its name decoded and lower-cased, and where its "("
 * is), or null when no name there is followed by "(".
 */
function functionAt(text: string, i: number): { name: string; open: number } | null {
  const id = identAt(text, i);
  return id.name && text[id.end] === "(" ? { name: id.name.toLowerCase(), open: id.end } : null;
}

/** True when c is a code point the tokenizer does not allow in an unquoted url(): U+0000-0008, U+000B, U+000E-001F, U+007F. */
function isNonPrintable(c: string): boolean {
  const n = c.charCodeAt(0);
  return n <= 0x08 || n === 0x0b || (n >= 0x0e && n <= 0x1f) || n === 0x7f;
}

/**
 * The url() starting at text[i], or null. Its name may be written with escapes: "\75rl(", "u\72l(" and
 * "\55 RL(" are url(. Read as the tokenizer reads it: `url(` then a string is a url() function, its
 * string followed by nothing but whitespace and comments up to ")"; otherwise it is a url token, whose
 * value ends at ")" or at whitespace followed by ")", and a quote, "(", a non-printable character, a
 * backslash before a newline or anything after the whitespace makes it a bad url, which fetches
 * nothing (null). In both, the end of the text closes it, as it closes a string.
 */
function urlAt(text: string, i: number, fn = functionAt(text, i)): CssRef | null {
  return urlTokenAt(text, i, fn)?.ref ?? null;
}

/**
 * urlAt's reading, with where the tokenizer goes on reading after it (`end`): past the url(), past
 * a bad url's remnants (up to its ")" or the end, escapes included, a quote in them not a string),
 * or, for a url() function that is not a URL, past its string. Null when no url( starts at text[i].
 */
function urlTokenAt(text: string, i: number, fn = functionAt(text, i)): { ref: CssRef | null; end: number } | null {
  if (fn?.name !== "url") return null;
  let k = fn.open + 1;
  while (isCssSpace(text[k])) k++;
  const ok = (end: number, raw: string) => {
    const e = Math.min(end, text.length);
    return { ref: { index: i, length: e - i, raw }, end: e };
  };
  if (text[k] === '"' || text[k] === "'") {
    const s = stringAt(text, k);
    if (s.bad) return { ref: null, end: s.end };
    const close = skipSpaceAndComments(text, s.end);
    return close >= text.length || text[close] === ")" ? ok(close + 1, s.raw) : { ref: null, end: s.end };
  }
  const start = k;
  while (k < text.length) {
    const c = text[k]!;
    if (c === ")") return ok(k + 1, text.slice(start, k));
    if (isCssSpace(c)) {
      const close = skipSpace(text, k);
      return close >= text.length || text[close] === ")" ? ok(close + 1, text.slice(start, k)) : { ref: null, end: badUrlEnd(text, k) };
    }
    if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) return { ref: null, end: badUrlEnd(text, k) };
    if (c === "\\") {
      if (isNewline(text[k + 1])) return { ref: null, end: badUrlEnd(text, k) };
      k = escapeAt(text, k).end;
    } else k++;
  }
  return ok(text.length, text.slice(start));
}

/** Where a bad url's remnants from text[k] end: just past its ")", or the end; an escape is read whole, so "\)" does not end it. */
function badUrlEnd(text: string, k: number): number {
  while (k < text.length) {
    const c = text[k];
    if (c === ")") return k + 1;
    k = c === "\\" && !isNewline(text[k + 1]) ? escapeAt(text, k).end : k + 1;
  }
  return text.length;
}

/**
 * Where the tokenizer goes on reading after the name at text[i] (isNameChar): past a url() whole
 * (a bad one's remnants too), to the "(" of another function, or past the name.
 */
function afterName(text: string, i: number, fn = functionAt(text, i)): number {
  const u = urlTokenAt(text, i, fn);
  if (u) return u.end;
  return fn ? fn.open : Math.max(identAt(text, i).end, i + 1);
}

/** Where the whitespace starting at text[i] ends (no comments: in a url token, "/*" is part of the value). */
function skipSpace(text: string, i: number): number {
  while (isCssSpace(text[i])) i++;
  return i;
}

/** True when a font's src entry is a url() (its name may be written with escapes), not a local(). */
function isUrlEntry(entry: string): boolean {
  return urlAt(entry.trim(), 0) !== null;
}

/**
 * Every url() in text. A name is read whole, as the CSS tokenizer reads it, so "myurl(" is not one;
 * its escapes are decoded, so "\75rl(" is. Comments and strings are read past as the tokenizer reads
 * them (a string the end of the text closes runs to the end), so a "url(" in one is not a url(), and
 * neither is one in a bad url's remnants.
 */
export function urlTokens(text: string): CssRef[] {
  const found: CssRef[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "*") i = commentEnd(text, i);
    else if (c === '"' || c === "'") i = stringAt(text, i).end;
    else if (isNameChar(c)) {
      const u = urlTokenAt(text, i);
      if (u?.ref) found.push(u.ref);
      i = u ? u.end : afterName(text, i);
    } else i++;
  }
  return found;
}

/** True when CSS text may name a resource that inlining replaces: a url(), or a string in an image-set(). */
export function hasCssRefs(text: string): boolean {
  if (/url\(|image-set\(/i.test(text)) return true;
  // a name written with escapes ("\75rl(", "image-s\65t(") is read as Chromium reads it
  return text.includes("\\") && (urlTokens(text).length > 0 || imageSetStrings(text).length > 0);
}

/** True when a function name (decoded, lower-cased) is an image-set(). */
function isImageSet(name: string): boolean {
  return name === "image-set" || name === "-webkit-image-set";
}

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
      if (isNewline(next)) break; // not an escape: the name ends
      const e = escapeAt(text, k);
      name += e.value;
      k = e.end;
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

/**
 * The quoted string starting at text[i]: where it ends and what it holds as written. As the tokenizer
 * reads it, the end of the text closes it; a backslash before a newline continues it on the next line;
 * a newline without one ends it as a bad string (`bad`, which fetches nothing), just before that newline.
 */
function stringAt(text: string, i: number): { end: number; raw: string; bad: boolean } {
  const quote = text[i];
  let k = i + 1;
  while (k < text.length) {
    const c = text[k];
    if (c === quote) return { end: k + 1, raw: text.slice(i + 1, k), bad: false };
    if (isNewline(c)) return { end: k, raw: text.slice(i + 1, k), bad: true };
    k = c === "\\" ? stringEscapeEnd(text, k) : k + 1;
  }
  return { end: text.length, raw: text.slice(i + 1), bad: false };
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
    if (isCssSpace(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = commentEnd(text, i);
    } else if (c === '"' || c === "'") {
      const s = stringAt(text, i);
      // only the image of an option: a string in type() or another function is not a URL; a bad string fetches nothing
      if (depth === 0 && atOption && !s.bad) found.push({ index: i, length: s.end - i, raw: s.raw });
      atOption = false;
      i = s.end;
    } else if (isNameChar(c)) {
      // a name, a url() read whole (a bad one's remnants too: a quote in them is not a string), or a function's name
      atOption = false;
      i = afterName(text, i);
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
    if (c === "/" && text[i + 1] === "*") i = commentEnd(text, i);
    else if (c === '"' || c === "'") i = stringAt(text, i).end;
    else if (isNameChar(c)) {
      // a name is read whole, its escapes decoded: "image-s\65t(" is an image-set(
      const fn = functionAt(text, i);
      i = fn && isImageSet(fn.name) ? scanImageSet(text, fn.open + 1, found) : afterName(text, i, fn);
    } else i++;
  }
  return found;
}

/**
 * Replaces every url() in a piece of CSS text (a declaration value, a style attribute), and every
 * string argument of an image-set(), with a data: URI of the resource it names. A resource that
 * cannot be had becomes UNFETCHED_URL, followed by a comment with its absolute URL, so the archive
 * still says where it was; or, given `unfetched`, what that returns for its URL and its place in text.
 * `dataUri` makes the data: URI (toDataUri; an SVG animation's `values` list needs one with no ";").
 */
export async function inlineUrls(
  text: string,
  base: string,
  ctx: CssContext,
  unfetched: (url: string, index: number) => string = (url) => `${UNFETCHED_URL} /*${unfetchedNote("", url)}*/`,
  dataUri: (bytes: Uint8Array, mime: string) => string = toDataUri,
): Promise<string> {
  if (!hasCssRefs(text)) return text;
  const all = [...urlTokens(text), ...(/image-set\(|\\/i.test(text) ? imageSetStrings(text) : [])].sort((a, b) => a.index - b.index);
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
      return res ? `url("${dataUri(res.bytes, res.mime)}")` : unfetched(url, r.index);
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

/** True when a declaration's property (its escapes decoded) is a custom property, `--*`. */
export function isCustomProperty(prop: string): boolean {
  return identAt(prop, 0).name.startsWith("--");
}

/**
 * The strings in a custom property's value (`list` false: text is that value), or in the value of
 * every custom property of a declaration list, a style attribute or a sheet postcss could not
 * parse (`list` true). var() can bring such a string into an image-set(), which fetches it as it
 * does a url(). Not a string in a url() or in an image-set() written in the value: inlineUrls has
 * those. Comments, strings and a bad url's remnants are read past as the tokenizer reads them.
 */
export function customPropertyStrings(text: string, list: boolean): CssRef[] {
  const found: CssRef[] = [];
  let inValue = !list; // reading a custom property's value
  let atStart = true; // where a declaration may start (after "{", ";", "}" or at the start)
  let depth = 0; // brackets open in the value
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "*") {
      i = commentEnd(text, i);
    } else if (isCssSpace(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      const s = stringAt(text, i);
      if (inValue && !s.bad) found.push({ index: i, length: s.end - i, raw: s.raw });
      atStart = false;
      i = s.end;
    } else if (isNameChar(c)) {
      const fn = functionAt(text, i);
      if (list && !inValue && atStart && !fn) {
        const id = identAt(text, i);
        const colon = skipSpaceAndComments(text, id.end);
        if (id.name.startsWith("--") && text[colon] === ":") {
          inValue = true;
          depth = 0;
          atStart = false;
          i = colon + 1;
          continue;
        }
      }
      atStart = false;
      i = fn && isImageSet(fn.name) ? scanImageSet(text, fn.open + 1, []) : afterName(text, i, fn);
    } else {
      if (inValue) {
        if (c === "(" || c === "[" || c === "{") depth++;
        else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
        else if (list && depth === 0 && (c === ";" || c === "}")) inValue = false;
      }
      atStart = list && !inValue && (c === ";" || c === "{" || c === "}");
      i++;
    }
  }
  return found;
}

/**
 * Replaces each string of a custom property in text (customPropertyStrings) that names an image the
 * browser fetched while the page loaded (ctx.fetched) with a data: URI string of it; one the browser
 * asked for (ctx.requested) whose bytes cannot be had (an HTTP error, a cap) is set aside, as
 * "data:" and a comment with its URL. Any other string is kept as written, a resource that is not
 * an image too ("/" names the page itself): a custom property holds font names and `content` text
 * as often as images, and only the browser's fetch and the image's type tell them apart. With no
 * ctx.fetched (a caller that did not record the page's loads), every string is kept as written.
 */
export async function inlineCustomPropertyStrings(text: string, base: string, ctx: CssContext, list: boolean): Promise<string> {
  const fetched = ctx.fetched;
  if (!fetched || !/["']/.test(text)) return text;
  const requested = ctx.requested ?? fetched;
  const refs = customPropertyStrings(text, list);
  if (!refs.length) return text;
  const replacements = await Promise.all(
    refs.map(async (r) => {
      const url = resolveCssUrl(r.raw, base);
      const asWritten = text.slice(r.index, r.index + r.length);
      if (!url || !(fetched(url) || requested(url))) return asWritten;
      const res = await ctx.get(url);
      if (!res) return `"data:" /*${unfetchedNote("", url)}*/`;
      // an image-set() takes only images: a string that names the page or a sheet is text
      return effectiveMime(res.mime, res.bytes).startsWith("image/") ? `"${toDataUri(res.bytes, res.mime)}"` : asWritten;
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
  // the URL is a string or a url(), read as the tokenizer reads them; comments around it are skipped
  const start = skipSpaceAndComments(params, 0);
  let raw: string;
  let end: number;
  if (params[start] === '"' || params[start] === "'") {
    const s = stringAt(params, start);
    if (s.bad) return null;
    raw = s.raw;
    end = s.end;
  } else {
    const u = urlAt(params, start);
    if (!u) return null;
    raw = u.raw;
    end = start + u.length;
  }
  let rest = params.slice(skipSpaceAndComments(params, end)).trim();
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
  if (text[i] !== "(") return stringAt(text, i).end;
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === '"' || c === "'") k = stringAt(text, k).end - 1;
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
    else if (c === '"' || c === "'") i = stringAt(css, i).end;
    else if (isNameChar(c)) i = afterName(css, i);
    else if (c === "@" && !/[\w\-\\]/.test(css[i - 1] ?? "") && isImportAt(css, i + 1)) {
      // the name may be written with escapes ("@\69mport"), which Chromium decodes
      const nameEnd = identAt(css, i + 1).end;
      let end = nameEnd;
      while (end < css.length && css[end] !== ";" && css[end] !== "{" && css[end] !== "}") {
        if (css[end] === '"' || css[end] === "'" || css[end] === "(") end = groupEnd(css, end);
        else if (css[end] === "/" && css[end + 1] === "*") end = commentEnd(css, end);
        else if (isNameChar(css[end])) end = afterName(css, end);
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

/** True when a declaration's value is one var() can bring into an image-set(): a custom property's, or an @property's initial-value. */
function holdsCustomValue(decl: Declaration): boolean {
  if (isCustomProperty(decl.prop)) return true;
  const parent = decl.parent;
  return decl.prop.toLowerCase() === "initial-value" && parent?.type === "atrule" && (parent as AtRule).name.toLowerCase() === "property";
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
    const urls = await inlineUrls(setImportsAside(css, sheetUrl), sheetUrl, ctx);
    return inlineCustomPropertyStrings(urls, sheetUrl, ctx, true);
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
      decl.value = pruneFontSrc(
        decl.value,
        (entry) => {
          const ref = urlAt(entry, 0);
          const url = ref ? resolveCssUrl(ref.raw, sheetUrl) : null;
          return !!url && fetched(url);
        },
        isUrlEntry,
      );
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
    const custom = holdsCustomValue(decl);
    if (hasCssRefs(decl.value) || custom) {
      decls.push(
        (async () => {
          const v = hasCssRefs(decl.value) ? await inlineUrls(decl.value, sheetUrl, ctx) : decl.value;
          decl.value = custom ? await inlineCustomPropertyStrings(v, sheetUrl, ctx, false) : v;
        })(),
      );
    }
  });
  await Promise.all(decls);
  return root.toString();
}

/** Decodes a stylesheet's bytes (UTF-8, BOM dropped). */
export { decode as decodeCss };
