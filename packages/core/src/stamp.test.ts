import { describe, expect, it } from "vitest";
import { parseDocument, serializeDocument } from "./dom.ts";
import { canonicalUrl, finalizeStamp, readStamp, stamp, verifyStamp } from "./stamp.ts";

const AT = new Date("2026-10-20T08:00:00.000Z");

function stamped(html: string, sourceUrl = "http://site.test/a?x=1&y=2") {
  const doc = parseDocument(html);
  stamp(doc, { sourceUrl, canonicalUrl: canonicalUrl(doc), capturedAt: AT, toolVersion: "9.9.9" });
  return finalizeStamp(serializeDocument(doc));
}

describe("stamp", () => {
  it("writes charset first, then the page-archiver metas", () => {
    const { html } = stamped(`<!doctype html><html><head><title>t</title><link rel="canonical" href="https://example.com/c"></head><body>b</body></html>`);
    const head = html.slice(html.indexOf("<head>") + 6, html.indexOf("<title>"));
    expect(head.startsWith(`<meta charset="utf-8">`)).toBe(true);
    expect(readStamp(html)).toEqual({
      "source-url": "http://site.test/a?x=1&y=2",
      "canonical-url": "https://example.com/c",
      "captured-at": "2026-10-20T08:00:00.000Z",
      "tool-version": "9.9.9",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("replaces the page's own charset declarations and any earlier stamp", () => {
    const { html } = stamped(
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><meta charset="windows-1252"><meta name="page-archiver:source-url" content="old"></head></html>`,
    );
    expect(html.match(/charset/g)).toHaveLength(1);
    expect(html).not.toContain("old");
  });

  it("omits canonical-url when the page has none", () => {
    expect(readStamp(stamped(`<p>x</p>`).html)).not.toHaveProperty("canonical-url");
  });

  it("hashes the file so a change is detectable", () => {
    const { html, sha256 } = stamped(`<p>hello</p>`);
    expect(readStamp(html)["sha256"]).toBe(sha256);
    expect(verifyStamp(html)).toBe(true);
    expect(verifyStamp(html.replace("hello", "hullo"))).toBe(false);
    expect(verifyStamp("<p>no stamp</p>")).toBe(false);
  });

  it("refuses to finalize twice", () => {
    const { html } = stamped(`<p>x</p>`);
    expect(() => finalizeStamp(html)).toThrow(/unfilled/);
  });
});
