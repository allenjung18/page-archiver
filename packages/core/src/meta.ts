// meta.json: what the library knows about one capture, written beside archive.html and
// rebuilt into the search index from the folder. META_SCHEMA is its JSON Schema.
import { randomBytes } from "node:crypto";

/** The file name of a capture's metadata inside its folder. */
export const META_FILE = "meta.json";

export interface PageMeta {
  /** The capture's id: 12 characters of [0-9a-z]. */
  id: string;
  /** The URL that was captured (as asked for). */
  url: string;
  /** The page's <link rel=canonical>, when it has one. */
  canonicalUrl: string | null;
  title: string;
  byline: string | null;
  /** The site's own name (og:site_name), else the page's host name. */
  site: string | null;
  excerpt: string | null;
  lang: string | null;
  /** ISO 8601, UTC. */
  capturedAt: string;
  /** The id of the capture this one is a newer version of. */
  versionOf?: string;
  /** The size in bytes of each file written; a file not made has no entry. */
  bytes: { archive: number; reader?: number; mhtml?: number; png?: number; pdf?: number };
  /** The archive's sha256 (its page-archiver:sha256 meta). */
  sha256: string;
  tags: string[];
  tool: { name: string; version: string };
  /** The capture's warnings, summarized. */
  warnings: string[];
}

const ID = "^[0-9a-z]{12}$";
const nullableString = { type: ["string", "null"] } as const;
const size = { type: "integer", minimum: 0 } as const;

/** JSON Schema (draft 2020-12) for meta.json. */
export const META_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://page-archiver.invalid/schema/meta.json",
  title: "page-archiver capture metadata",
  type: "object",
  additionalProperties: false,
  required: ["id", "url", "canonicalUrl", "title", "byline", "site", "excerpt", "lang", "capturedAt", "bytes", "sha256", "tags", "tool", "warnings"],
  properties: {
    id: { type: "string", pattern: ID },
    url: { type: "string", pattern: "^https?://\\S+$" },
    canonicalUrl: { type: ["string", "null"], minLength: 1 },
    title: { type: "string", minLength: 1 },
    byline: nullableString,
    site: nullableString,
    excerpt: nullableString,
    lang: nullableString,
    capturedAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$" },
    versionOf: { type: "string", pattern: ID },
    bytes: {
      type: "object",
      additionalProperties: false,
      required: ["archive"],
      properties: { archive: { ...size, minimum: 1 }, reader: size, mhtml: size, png: size, pdf: size },
    },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    tags: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    tool: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: { name: { type: "string", minLength: 1 }, version: { type: "string", minLength: 1 } },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A new capture id: 12 random characters of [0-9a-z] (about 62 bits). */
export function newPageId(): string {
  // 252 = 7 * 36: bytes at or above it are dropped so every character is equally likely
  let id = "";
  while (id.length < 12) {
    for (const b of randomBytes(16)) {
      if (b < 252 && id.length < 12) id += ALPHABET[b % 36];
    }
  }
  return id;
}

/** Tags trimmed, empty ones dropped, duplicates removed, first-seen order kept. */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

/** meta.json's text: two-space indented, one trailing newline. */
export function serializeMeta(meta: PageMeta): string {
  return JSON.stringify(meta, null, 2) + "\n";
}
