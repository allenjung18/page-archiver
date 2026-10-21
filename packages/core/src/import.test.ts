import { describe, expect, it } from "vitest";
import { importHtml, readOwnStamp, readSavedHeader, readSingleFileHeader } from "./import.ts";
import { parseDocument, serializeDocument } from "./dom.ts";
import { finalizeStamp, readStamp, stamp, verifyStamp } from "./stamp.ts";

const SAVE = `<!DOCTYPE html> <html lang="en"><!--
 Page saved with SingleFile 
 url: https://example.org/notes/kelp#top 
 saved date: Mon Oct 19 2026 10:00:00 GMT-0700 (Pacific Daylight Time)
--><head><meta charset="utf-8"><title>Kelp forests</title><script>alert(1)</script>
<link rel="canonical" href="https://example.org/kelp"></head>
<body><article><h1>Kelp forests</h1><p>The kelp grows quickly in cold water near the shelf. Otters keep urchins in check, which keeps
the forest standing through the long winter storms of the northern coast.</p><p onclick="steal()">Holdfasts grip the rock and the
stipes hold the canopy up toward the light, a metre a week in a good spring.</p><a href="javascript:alert(2)">x</a></article></body></html>`;

describe("readSingleFileHeader", () => {
  it("reads the url and the saved date", () => {
    expect(readSingleFileHeader(SAVE)).toEqual({ url: "https://example.org/notes/kelp#top", savedAt: new Date("2026-10-19T17:00:00Z") });
  });

  it("is null for a file SingleFile did not write, and a bad date is null", () => {
    expect(readSingleFileHeader("<!doctype html><!-- hello --><p>x")).toBeNull();
    expect(readSingleFileHeader("<!--\n Page saved with SingleFile\n url: https://a.test/\n saved date: not a date\n-->")).toEqual({ url: "https://a.test/", savedAt: null });
  });

  it("takes a date outside the years 1000 to 9999 as no date (a library folder is named by a four-digit year)", () => {
    for (const date of ["Sat Jan 01 10000 00:00:00 GMT+0000", "Mon Jan 01 0999 00:00:00 GMT+0000"]) {
      const html = `<!--\n Page saved with SingleFile\n url: https://a.test/\n saved date: ${date}\n-->`;
      expect(readSingleFileHeader(html), date).toEqual({ url: "https://a.test/", savedAt: null });
    }
    expect(readSingleFileHeader("<!--\n Page saved with SingleFile\n url: https://a.test/\n saved date: Fri Dec 31 9999 23:59:59 GMT+0000\n-->")?.savedAt).toEqual(new Date("9999-12-31T23:59:59Z"));
  });
});

describe("importHtml", () => {
  it("sanitizes, stamps and describes a SingleFile save", () => {
    const a = importHtml(SAVE, { id: "abcdefabcdef", tags: ["sea", " sea "], source: "kelp.html" });
    expect(a.html).not.toMatch(/<script|onclick|javascript:/i);
    expect(verifyStamp(a.html)).toBe(true);
    expect(readStamp(a.html)).toMatchObject({ "source-url": "https://example.org/notes/kelp#top", "captured-at": "2026-10-19T17:00:00.000Z", "canonical-url": "https://example.org/kelp" });
    expect(a.meta).toMatchObject({
      id: "abcdefabcdef",
      url: "https://example.org/notes/kelp#top",
      canonicalUrl: "https://example.org/kelp",
      title: "Kelp forests",
      site: "example.org",
      capturedAt: "2026-10-19T17:00:00.000Z",
      tags: ["sea"],
      sha256: a.sha256,
    });
    expect(a.meta.warnings[0]).toBe("imported from kelp.html (SingleFile)");
    // the file's name is in meta.json only: the stamped bytes are the same under any name
    expect(a.html).not.toContain("kelp.html");
    expect(importHtml(SAVE, { id: "abcdefabcdef", source: "renamed.html" }).sha256).toBe(a.sha256);
    expect(a.meta.warnings[1]).toMatch(/^removed 1 script elements and 2 script attributes$/);
    expect(a.reader?.html).toContain("Holdfasts grip the rock");
    expect(a.meta.bytes.reader).toBe(Buffer.byteLength(a.reader!.html));
  });

  it("takes the URL and date it is given when the file has none, and refuses without a URL", () => {
    const plain = "<!doctype html><title>T</title><p>Body text.";
    const a = importHtml(plain, { url: "https://a.test/p", savedAt: new Date("2026-01-02T03:04:05Z"), reader: false });
    expect(a.meta).toMatchObject({ url: "https://a.test/p", capturedAt: "2026-01-02T03:04:05.000Z", title: "T" });
    expect(a.reader).toBeUndefined();
    expect(() => importHtml(plain)).toThrow(/which URL/);
    expect(() => importHtml(plain, { url: "file:///etc/passwd" })).toThrow(/only http/);
  });

  it("lets an explicit URL win over the file's own", () => {
    expect(importHtml(SAVE, { url: "https://other.test/k" }).meta.url).toBe("https://other.test/k");
  });
});

describe("importHtml of an archive page-archiver made (the Chrome extension's)", () => {
  /** An archive stamped as assemble() stamps one. */
  function ours(body = "<p>Captured text, long enough to read.</p>"): string {
    const doc = parseDocument(`<!doctype html><title>Ours</title>${body}`);
    stamp(doc, { sourceUrl: "https://made.test/p", capturedAt: new Date("2026-10-20T08:00:00Z"), toolVersion: "0.1.0", warnings: ["x.png: fetch failed (HTTP 404); set aside"] });
    return finalizeStamp(serializeDocument(doc)).html;
  }

  it("keeps the stamp's URL, capture time and warnings, and says nothing about an import", () => {
    expect(readOwnStamp(ours())).toEqual({
      tool: "page-archiver",
      url: "https://made.test/p",
      savedAt: new Date("2026-10-20T08:00:00Z"),
      warnings: ["x.png: fetch failed (HTTP 404); set aside"],
    });
    const a = importHtml(ours(), { savedAt: new Date("2030-01-01T00:00:00Z"), source: "the Chrome extension", reader: false });
    expect(a.meta).toMatchObject({ url: "https://made.test/p", capturedAt: "2026-10-20T08:00:00.000Z", title: "Ours" });
    expect(a.meta.warnings).toEqual(["x.png: fetch failed (HTTP 404); set aside"]);
    expect(JSON.parse(readStamp(a.html)["warnings"]!)).toEqual(a.meta.warnings);
    expect(verifyStamp(a.html)).toBe(true);
    // nothing changed, so the import is the same bytes
    expect(a.html).toBe(ours());
  });

  it("takes a stamped capture time outside the years 1000 to 9999 as no time", () => {
    const doc = parseDocument(`<!doctype html><title>Far</title><p>Captured text.</p>`);
    stamp(doc, { sourceUrl: "https://made.test/far", capturedAt: new Date("+010000-01-01T00:00:00Z"), toolVersion: "0.1.0", warnings: [] });
    expect(readOwnStamp(finalizeStamp(serializeDocument(doc)).html)?.savedAt).toBeNull();
  });

  it("still sanitizes it, whatever it claims to be", () => {
    const a = importHtml(ours('<script>steal()</script><p onclick="x()">Text.</p>'), { reader: false });
    expect(a.html).not.toMatch(/<script|onclick/);
    expect(a.meta.warnings).toEqual(["x.png: fetch failed (HTTP 404); set aside", "removed 1 script elements and 1 script attributes"]);
  });

  it("prefers its own intact stamp to a SingleFile comment the page carried, and SingleFile's to a stamp edited since", () => {
    expect(readSavedHeader(SAVE)).toMatchObject({ tool: "singlefile", url: "https://example.org/notes/kelp#top" });
    expect(readSavedHeader("<!doctype html><p>x")).toBeNull();
    // a page that is itself a SingleFile save (hosted on the web), archived by page-archiver
    const quoting = ours(`<!--\n Page saved with SingleFile\n url: https://elsewhere.test/\n saved date: 2001-01-01T00:00:00Z\n--><p>Quoted.</p>`);
    expect(quoting).toContain("Page saved with SingleFile");
    expect(readSavedHeader(quoting)).toMatchObject({ tool: "page-archiver", url: "https://made.test/p", savedAt: new Date("2026-10-20T08:00:00Z") });
    const a = importHtml(quoting, { reader: false });
    expect(a.meta).toMatchObject({ url: "https://made.test/p", capturedAt: "2026-10-20T08:00:00.000Z" });
    expect(a.meta.warnings).toEqual(["x.png: fetch failed (HTTP 404); set aside"]);
    // the same bytes changed after the stamp (re-saved by SingleFile): SingleFile's header wins
    expect(readSavedHeader(quoting.replace("Quoted.", "Edited."))).toMatchObject({ tool: "singlefile", url: "https://elsewhere.test/" });
  });
});
