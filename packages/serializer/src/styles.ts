// Stylesheets as the browser holds them, not as the HTML says. CSS-in-JS libraries
// (styled-components, emotion) add rules with insertRule, so their <style> elements are empty or
// stale while the CSSOM holds every rule; constructed sheets adopted by a document or a shadow
// root (adoptedStyleSheets) are not in the DOM at all. Both are written back as <style> text.

/** Marks a <style> the serializer wrote for an adopted sheet. */
export const ADOPTED_ATTRIBUTE = "data-page-archiver-adopted";

/** The text of a sheet's rules, one per line, or null when they cannot be read (a cross-origin sheet). */
export function cssomText(sheet: CSSStyleSheet): string | null {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < rules.length; i++) out.push(rules[i]!.cssText);
  return out.join("\n");
}

function withoutImports(sheet: CSSStyleSheet): string[] {
  const out: string[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    const isImport = (typeof CSSImportRule !== "undefined" && rule instanceof CSSImportRule) || /^@import\s/i.test(rule.cssText);
    if (!isImport) out.push(rule.cssText);
  }
  return out;
}

/**
 * The CSS a cloned <style> must hold to style the archive as the live one styles the page: its own
 * text when the CSSOM still matches it (keeping what the author wrote, vendor hacks included), and
 * the CSSOM's text when script changed the rules (insertRule, deleteRule, an emptied element).
 * Null means "keep the element's text".
 */
export function styleElementText(style: HTMLStyleElement): string | null {
  const sheet = style.sheet;
  if (!sheet) return null;
  let live: string[];
  try {
    live = withoutImports(sheet);
  } catch {
    return null;
  }
  const text = style.textContent ?? "";
  if (!text.trim()) return live.length ? cssomText(sheet) : null;
  // What the element's text would parse to now. @import is not allowed in a constructed sheet, so
  // both sides are compared without it.
  let parsed: string[];
  try {
    const probe = new CSSStyleSheet();
    probe.replaceSync(text);
    parsed = withoutImports(probe);
  } catch {
    return null;
  }
  if (parsed.length === live.length && parsed.every((r, i) => r === live[i])) return null;
  return cssomText(sheet);
}

/** True when script disabled the element's sheet (sheet.disabled = true): it must stay off in the archive. */
export function sheetDisabled(el: HTMLStyleElement | HTMLLinkElement): boolean {
  return !!el.sheet?.disabled;
}

/**
 * <style> elements, in order, for the sheets adopted by a document or shadow root. Adopted sheets
 * come after the root's own sheets in the cascade, so callers append them at the end.
 */
export function adoptedStyles(root: Document | ShadowRoot, into: Document): HTMLStyleElement[] {
  const sheets = (root as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [];
  const out: HTMLStyleElement[] = [];
  for (const sheet of sheets) {
    const text = cssomText(sheet);
    if (text === null) continue;
    const style = into.createElement("style");
    style.setAttribute(ADOPTED_ATTRIBUTE, "");
    const media = sheet.media?.mediaText;
    if (media) style.setAttribute("media", media);
    if (sheet.disabled) style.setAttribute("media", "not all");
    style.textContent = text;
    out.push(style);
  }
  return out;
}
