import { describe, expect, it } from "vitest";
import { parseDocument, serializeDocument } from "./dom.ts";
import { canonicalUrl, finalizeStamp, readStamp, stamp, verifyStamp } from "./stamp.ts";

const AT = new Date("2026-10-20T08:00:00.000Z");

function stamped(html: string, sourceUrl = "http://site.test/a?x=1&y=2") {
  const doc = parseDocument(html);
  stamp(doc, { sourceUrl, canonicalUrl: canonicalUrl(doc), capturedAt: AT, toolVersion: "9.9.9" });
  return finalizeStamp(serializeDocument(doc));
}

describe("serializeDocument", () => {
  it("keeps a doctype's public and system ids, so quirks mode survives", () => {
    for (const dt of [
      `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">`, // parse5 lower-cases the name
      `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">`,
      `<!DOCTYPE html SYSTEM "about:legacy-compat">`,
    ]) {
      const doc = parseDocument(`${dt}<p>x</p>`);
      const out = serializeDocument(doc);
      expect(out.startsWith(dt), out.slice(0, 120)).toBe(true);
      expect(parseDocument(out).mode).toBe(doc.mode);
    }
    expect(serializeDocument(parseDocument(`<!doctype html><p>x</p>`)).startsWith("<!DOCTYPE html><html>")).toBe(true);
    expect(parseDocument(serializeDocument(parseDocument(`<p>no doctype</p>`))).mode).toBe("quirks");
  });
});

describe("stamp", () => {
  it("writes the summarized warnings as JSON, read back by readStamp, covered by the hash", () => {
    const doc = parseDocument(`<!doctype html><title>t</title>`);
    const warnings = [`2 resources could not be loaded, set aside`, `canvas "c" & co`];
    stamp(doc, { sourceUrl: "http://s.test/", capturedAt: AT, toolVersion: "1", warnings });
    const { html } = finalizeStamp(serializeDocument(doc));
    expect(JSON.parse(readStamp(html)["warnings"]!)).toEqual(warnings);
    expect(verifyStamp(html)).toBe(true);
    expect(readStamp(stamped(`<title>t</title>`).html)["warnings"]).toBeUndefined();
  });

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
