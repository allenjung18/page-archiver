import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

const fed = vi.hoisted(() => ({ queue: [] as Uint8Array[] }));
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  return { ...real, randomBytes: (n: number) => fed.queue.shift() ?? real.randomBytes(n) };
});

import { META_SCHEMA, newPageId, normalizeTags, serializeMeta, type PageMeta } from "./meta.ts";

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(META_SCHEMA);

const meta: PageMeta = {
  id: "0a1b2c3d4e5f",
  url: "https://gazette.example/tides",
  canonicalUrl: "https://gazette.example/2026/03/tides",
  title: "Tides of the Inner Basin",
  byline: "Mara Quill",
  site: "The Harbour Gazette",
  excerpt: "Why the inner basin floods.",
  lang: "en-GB",
  capturedAt: "2026-03-12T10:00:00.000Z",
  bytes: { archive: 1200, reader: 300, mhtml: 4000, png: 5000, pdf: 6000 },
  sha256: "a".repeat(64),
  tags: ["sea"],
  tool: { name: "page-archiver", version: "0.1.0" },
  warnings: [],
};

describe("META_SCHEMA", () => {
  it("accepts a full meta.json and a minimal one", () => {
    expect(validate(JSON.parse(serializeMeta(meta))), JSON.stringify(validate.errors)).toBe(true);
    const minimal = { ...meta, canonicalUrl: null, byline: null, site: null, excerpt: null, lang: null, bytes: { archive: 1 }, tags: [] };
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...meta, versionOf: "zzzzzzzzzzzz" }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses a meta.json that breaks it", () => {
    const without = (key: keyof PageMeta) => Object.fromEntries(Object.entries(meta).filter(([k]) => k !== key));
    const bad: Array<[string, unknown]> = [
      ["no title", without("title")],
      ["empty title", { ...meta, title: "" }],
      ["unknown field", { ...meta, extra: 1 }],
      ["bad id", { ...meta, id: "ABC" }],
      ["bad versionOf", { ...meta, versionOf: "nope" }],
      ["non-http url", { ...meta, url: "file:///etc/passwd" }],
      ["short sha256", { ...meta, sha256: "abc" }],
      ["local time", { ...meta, capturedAt: "2026-03-12T10:00:00+01:00" }],
      ["no archive size", { ...meta, bytes: { reader: 3 } }],
      ["empty archive", { ...meta, bytes: { archive: 0 } }],
      ["fractional size", { ...meta, bytes: { archive: 1.5 } }],
      ["unknown file", { ...meta, bytes: { archive: 1, zip: 3 } }],
      ["duplicate tags", { ...meta, tags: ["a", "a"] }],
      ["tool without version", { ...meta, tool: { name: "x" } }],
      ["warnings not strings", { ...meta, warnings: [1] }],
      ["byline missing", without("byline")],
    ];
    for (const [why, value] of bad) expect(validate(value), why).toBe(false);
  });
});

describe("newPageId", () => {
  it("makes 12 characters of [0-9a-z], different every time", () => {
    const ids = new Set(Array.from({ length: 500 }, newPageId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{12}$/);
  });

  it("drops the bytes at or above 252, so no character is likelier than another", () => {
    // 252..255 would map to 0..3 a second time (252 % 36 = 0): they must be skipped, not used
    fed.queue.push(Uint8Array.from([252, 253, 254, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(newPageId()).toBe("0123456789ab");
    // a draw that is mostly dropped asks for more bytes
    fed.queue.push(Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 35]));
    fed.queue.push(Uint8Array.from([71, 36, 251, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(newPageId()).toBe("zz0z00000000");
  });
});

describe("normalizeTags", () => {
  it("trims, drops empty tags and duplicates, keeps order", () => {
    expect(normalizeTags([" sea", "tides", "", "sea ", "  "])).toEqual(["sea", "tides"]);
  });
});
