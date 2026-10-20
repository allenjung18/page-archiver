import { describe, expect, it } from "vitest";
import { captureFolder, resolveLibraryDir, slugify } from "./layout.ts";
import { archiveText, readerText } from "./text.ts";
import { toFtsQuery } from "./search.ts";
import { urlKey } from "./versions.ts";

describe("resolveLibraryDir", () => {
  it("takes the flag, else $PA_LIBRARY, else ~/Archive/pages", () => {
    expect(resolveLibraryDir("/x/lib", { PA_LIBRARY: "/y" }, "/home/u")).toBe("/x/lib");
    expect(resolveLibraryDir(undefined, { PA_LIBRARY: "~/pages" }, "/home/u")).toBe("/home/u/pages");
    expect(resolveLibraryDir(undefined, {}, "/home/u")).toBe("/home/u/Archive/pages");
    expect(resolveLibraryDir("", {}, "/home/u")).toBe("/home/u/Archive/pages");
  });
});

describe("slugify and captureFolder", () => {
  it("makes short ASCII slugs", () => {
    expect(slugify("Tides of the Inner Basin")).toBe("tides-of-the-inner-basin");
    expect(slugify("Café — naïve résumé!")).toBe("cafe-naive-resume");
    expect(slugify("日本語")).toBe("page");
    expect(slugify("   ")).toBe("page");
    const long = slugify("a very long title that goes on and on well past the sixty character limit of a slug");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe("a-very-long-title-that-goes-on-and-on-well-past-the-sixty");
  });

  it("files a capture under the UTC year and month it was taken", () => {
    expect(captureFolder({ id: "0a1b2c3d4e5f", title: "Kelp", capturedAt: "2026-12-31T23:30:00-05:00" })).toBe("2027/01/kelp-0a1b2c3d4e5f");
    expect(() => captureFolder({ id: "0a1b2c3d4e5f", title: "Kelp", capturedAt: "soon" })).toThrow(/capturedAt/);
  });
});

describe("indexed text", () => {
  it("is the reader copy's article without its header, else the archive's visible body", () => {
    const reader = `<html><head><title>T</title></head><body><article><header><h1>T</h1><p class="pa-byline">B</p></header>
      <div class="pa-content"><p>One <b>two</b></p><p>three</p></div></article></body></html>`;
    expect(readerText(reader)).toBe("One two three");
    const archive = `<html><head><title>No</title><style>.x{}</style></head><body><p>Seen</p><script>no()</script>
      <div><template shadowrootmode="open"><span>shadow text</span></template></div><noscript>no</noscript></body></html>`;
    expect(archiveText(archive)).toBe("Seen shadow text");
  });
});

describe("toFtsQuery", () => {
  it("quotes words, keeps prefixes, phrases and operators between words", () => {
    expect(toFtsQuery("fog bell")).toBe('"fog" "bell"');
    expect(toFtsQuery("zanz*")).toBe('"zanz"*');
    expect(toFtsQuery('"rang the bell" keeper\'s')).toBe('"rang the bell" "keeper\'s"');
    expect(toFtsQuery("a OR b")).toBe('"a" OR "b"');
    expect(toFtsQuery("OR a OR OR b AND")).toBe('"a" OR "b"');
    expect(toFtsQuery('say "hi')).toBe('"say" "hi"');
    expect(() => toFtsQuery("- * ()")).toThrow(/nothing to search/);
  });
});

describe("urlKey", () => {
  it("ignores the fragment", () => {
    expect(urlKey("https://a.test/p?q=1#section")).toBe("https://a.test/p?q=1");
    expect(urlKey("not a url")).toBe("not a url");
  });
});
