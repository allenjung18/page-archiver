// Web fonts, kept only as far as the page used them. A site's stylesheets often declare dozens of
// @font-face rules (every weight, every unicode-range subset) of which the page loaded a few; the
// browser's FontFaceSet says which. A rule whose face the page never loaded is dropped (its font
// was never on screen); a rule the FontFaceSet does not know is kept, because dropping a font that
// was used costs more than keeping one that was not. Of a kept rule's src list, only the url() the
// browser actually fetched is inlined.
import type { AtRule } from "postcss";
import type { FontFaceInfo } from "@page-archiver/serializer";

export type { FontFaceInfo };

/** Decides per @font-face rule; built from a snapshot's font list. */
export interface FontFilter {
  /** "keep" | "drop" for a rule with these descriptors. */
  decide(rule: AtRule): "keep" | "drop";
  /** How many rules were dropped. */
  dropped: number;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return t;
}

export function normalizeFamily(s: string): string {
  return unquote(s).replace(/\s+/g, " ").toLowerCase();
}

const WEIGHT_KEYWORDS: Record<string, string> = { normal: "400", bold: "700" };

export function normalizeWeight(s: string | undefined): string {
  const parts = (s ?? "normal").trim().toLowerCase().split(/\s+/).map((p) => WEIGHT_KEYWORDS[p] ?? String(Number(p)));
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return parts.join(" ");
}

export function normalizeStyle(s: string | undefined): string {
  const v = (s ?? "normal").trim().toLowerCase().replace(/\s+/g, " ");
  return v === "oblique 14deg" ? "oblique" : v;
}

const STRETCH_KEYWORDS: Record<string, string> = {
  "ultra-condensed": "50%",
  "extra-condensed": "62.5%",
  condensed: "75%",
  "semi-condensed": "87.5%",
  normal: "100%",
  "semi-expanded": "112.5%",
  expanded: "125%",
  "extra-expanded": "150%",
  "ultra-expanded": "200%",
};

export function normalizeStretch(s: string | undefined): string {
  const parts = (s ?? "normal").trim().toLowerCase().split(/\s+/).map((p) => STRETCH_KEYWORDS[p] ?? p);
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return parts.join(" ");
}

/** A unicode-range as sorted, merged numeric ranges ("0-255,305-305"); the default covers everything. */
export function normalizeUnicodeRange(s: string | undefined): string {
  const ranges: Array<[number, number]> = [];
  for (const raw of (s ?? "U+0-10FFFF").split(",")) {
    const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(raw.trim());
    if (!m) continue;
    const a = m[1]!;
    if (a.includes("?")) ranges.push([parseInt(a.replace(/\?/g, "0"), 16), parseInt(a.replace(/\?/g, "f"), 16)]);
    else ranges.push([parseInt(a, 16), parseInt(m[2] ?? a, 16)]);
  }
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.map(([x, y]) => `${x}-${y}`).join(",");
}

export function faceKey(d: { family: string; weight?: string | undefined; style?: string | undefined; stretch?: string | undefined; unicodeRange?: string | undefined }): string {
  return [normalizeFamily(d.family), normalizeWeight(d.weight), normalizeStyle(d.style), normalizeStretch(d.stretch), normalizeUnicodeRange(d.unicodeRange)].join("|");
}

function descriptor(rule: AtRule, name: string): string | undefined {
  let value: string | undefined;
  rule.each((node) => {
    if (node.type === "decl" && node.prop.toLowerCase() === name) value = node.value;
  });
  return value;
}

/** A filter over a page's faces. With no font list (an older snapshot) every rule is kept. */
export function createFontFilter(faces: readonly FontFaceInfo[] | undefined): FontFilter | undefined {
  if (!faces) return undefined;
  const status = new Map<string, boolean>();
  for (const f of faces) {
    const key = faceKey(f);
    // "unloaded" was never asked for and "error" can never render; a face still loading is kept
    status.set(key, (status.get(key) ?? false) || (f.status !== "unloaded" && f.status !== "error"));
  }
  const filter: FontFilter = {
    dropped: 0,
    decide(rule) {
      const family = descriptor(rule, "font-family");
      if (!family) return "keep";
      const key = faceKey({
        family,
        weight: descriptor(rule, "font-weight"),
        style: descriptor(rule, "font-style"),
        stretch: descriptor(rule, "font-stretch"),
        unicodeRange: descriptor(rule, "unicode-range"),
      });
      const loaded = status.get(key);
      if (loaded === false) {
        filter.dropped++;
        return "drop";
      }
      return "keep";
    },
  };
  return filter;
}

/** Splits a src descriptor into its comma-separated entries (commas inside quotes or parens stay). */
export function splitSrc(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * The src list with its url() entries narrowed to the first one the browser fetched (`fetched`
 * says, given a url() entry). local() entries stay. When none was fetched the list is unchanged.
 */
export function pruneFontSrc(value: string, fetched: (entry: string) => boolean): string {
  const entries = splitSrc(value);
  const chosen = entries.find((e) => /^url\(/i.test(e) && fetched(e));
  if (!chosen) return value;
  return entries.filter((e) => !/^url\(/i.test(e) || e === chosen).join(", ");
}
