// Reads test/smoke-urls.txt: one real page per line, `label | url | expected text | miss: reason`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SMOKE_LIST = fileURLToPath(new URL("../smoke-urls.txt", import.meta.url));

export interface SmokePage {
  label: string;
  url: string;
  /** Text the archive must contain: proof it holds the page and not a bot wall or an error page. */
  expect: string;
  /** Set when the page is known not to save cleanly: why. */
  miss?: string;
  /** 1-based line in the list, for error messages. */
  line: number;
}

/** Lower case, every run of white space one space: how the expected text is matched. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parses the list's text. Throws on a malformed line, a URL that is not http(s), or a repeated label. */
export function parseSmokeList(text: string): SmokePage[] {
  const pages: SmokePage[] = [];
  const labels = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const content = raw.trim();
    if (!content || content.startsWith("#")) return;
    const fields = content.split(" | ").map((f) => f.trim());
    if (fields.length < 3 || fields.length > 4) {
      throw new Error(`smoke list line ${line}: expected "label | url | text [| miss: reason]", got ${JSON.stringify(content)}`);
    }
    const [label, url, expect, extra] = fields as [string, string, string, string | undefined];
    if (!/^[\w.-]+$/.test(label)) throw new Error(`smoke list line ${line}: label ${JSON.stringify(label)} must be letters, digits, ".", "_" or "-"`);
    if (labels.has(label)) throw new Error(`smoke list line ${line}: label ${label} is used twice`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`smoke list line ${line}: not a URL: ${url}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error(`smoke list line ${line}: only http and https pages: ${url}`);
    if (!expect) throw new Error(`smoke list line ${line}: the expected text is empty`);
    const page: SmokePage = { label, url, expect, line };
    if (extra !== undefined) {
      const m = /^miss:\s*(\S.*)$/.exec(extra);
      if (!m) throw new Error(`smoke list line ${line}: the fourth field must be "miss: <reason>", got ${JSON.stringify(extra)}`);
      page.miss = m[1]!;
    }
    labels.add(label);
    pages.push(page);
  });
  return pages;
}

export function readSmokeList(file: string = SMOKE_LIST): SmokePage[] {
  return parseSmokeList(readFileSync(file, "utf8"));
}

/**
 * Splits CSP violations into those whose URL a capture warning names (`<url>: …; kept as a link`:
 * the capture already said it could not have that resource) and the rest, which nothing explains.
 */
export function splitViolations<V extends { blockedURI: string }>(violations: readonly V[], warnings: readonly string[]): { reported: V[]; unreported: V[] } {
  const kept = new Set(warnings.filter((w) => /; kept as a link$/.test(w)).map((w) => w.slice(0, w.indexOf(": "))));
  const reported: V[] = [];
  const unreported: V[] = [];
  for (const v of violations) (v.blockedURI && kept.has(v.blockedURI) ? reported : unreported).push(v);
  return { reported, unreported };
}
