import { describe, expect, it } from "vitest";
import { importHtml, readSingleFileHeader } from "./import.ts";
import { readStamp, verifyStamp } from "./stamp.ts";

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
