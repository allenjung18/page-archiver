import postcss, { type AtRule } from "postcss";
import { describe, expect, it } from "vitest";
import type { Resource } from "../resources.ts";
import { inlineCss, type CssContext } from "./css.ts";
import { createFontFilter, faceKey, normalizeUnicodeRange, normalizeWeight, pruneFontSrc, splitSrc, type FontFaceInfo } from "./fonts.ts";

const WOFF2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);

function face(o: Partial<FontFaceInfo> & { family: string }): FontFaceInfo {
  return { style: "normal", weight: "normal", stretch: "normal", unicodeRange: "U+0-10FFFF", status: "loaded", ...o };
}

function rule(css: string): AtRule {
  return postcss.parse(css).first as AtRule;
}

describe("font face keys", () => {
  it("normalize the way a browser reports a face and the way a stylesheet writes it", () => {
    // what document.fonts says for a rule, against what the rule says
    expect(faceKey({ family: "My Face", weight: "bold", unicodeRange: "U+0-FF, U+131" })).toBe(
      faceKey({ family: `"My Face"`, weight: "700", style: "normal", unicodeRange: "U+0000-00FF,U+0131" }),
    );
    expect(normalizeWeight("300 500")).toBe("300 500");
    expect(normalizeWeight("400 400")).toBe("400");
    expect(normalizeWeight(undefined)).toBe("400");
    expect(normalizeUnicodeRange("U+4??")).toBe("1024-1279");
    expect(normalizeUnicodeRange(undefined)).toBe("0-1114111");
    expect(normalizeUnicodeRange("U+0100-02BA, U+0000-00FF")).toBe("0-698");
  });
});

describe("createFontFilter", () => {
  const filter = createFontFilter([
    face({ family: "Body", unicodeRange: "U+0-FF", status: "loaded" }),
    face({ family: "Body", unicodeRange: "U+100-24F", status: "unloaded" }),
    face({ family: "Icons", weight: "700", status: "error" }),
  ])!;

  it("keeps loaded faces, drops faces the page never loaded, keeps faces it does not know", () => {
    expect(filter.decide(rule(`@font-face { font-family: Body; src: url(a.woff2); unicode-range: U+0000-00FF; }`))).toBe("keep");
    expect(filter.decide(rule(`@font-face { font-family: "body"; src: url(b.woff2); unicode-range: U+0100-024F; }`))).toBe("drop");
    expect(filter.decide(rule(`@font-face { font-family: Icons; font-weight: bold; src: url(i.woff2); }`))).toBe("drop");
    expect(filter.decide(rule(`@font-face { font-family: Unknown; src: url(u.woff2); }`))).toBe("keep");
    expect(filter.decide(rule(`@font-face { src: url(nofamily.woff2); }`))).toBe("keep");
    expect(filter.dropped).toBe(2);
  });

  it("is absent when the snapshot has no font list (every rule kept)", () => {
    expect(createFontFilter(undefined)).toBeUndefined();
  });
});

describe("src lists", () => {
  it("split on top-level commas only", () => {
    expect(splitSrc(`local("A, B"), url("x,y.woff2") format("woff2"), url(z.woff)`)).toEqual([`local("A, B")`, `url("x,y.woff2") format("woff2")`, `url(z.woff)`]);
  });

  it("keep local() and the url() the browser fetched; unchanged when none was", () => {
    const src = `local(Body), url(a.woff2) format("woff2"), url(a.woff) format("woff")`;
    expect(pruneFontSrc(src, (e) => e.includes("a.woff)"))).toBe(`local(Body), url(a.woff) format("woff")`);
    expect(pruneFontSrc(src, () => false)).toBe(src);
  });
});

describe("inlineCss with a font filter", () => {
  it("drops unloaded faces before anything is fetched, and inlines only the fetched src", async () => {
    const asked: string[] = [];
    const ctx: CssContext = {
      async get(url): Promise<Resource | null> {
        asked.push(url);
        return { url, mime: "font/woff2", bytes: WOFF2 };
      },
      warn: () => undefined,
      fonts: createFontFilter([face({ family: "Body", status: "loaded" }), face({ family: "Spare", status: "unloaded" })]),
      fetched: (u) => u === "http://s.test/f/body.woff2",
    };
    const out = await inlineCss(
      `@font-face { font-family: Body; src: url(f/body.woff2) format("woff2"), url(f/body.woff) format("woff"); }
       @media screen { @font-face { font-family: Spare; src: url(f/spare.woff2); } }
       p { font-family: Body; }`,
      "http://s.test/site.css",
      ctx,
    );
    expect(asked).toEqual(["http://s.test/f/body.woff2"]);
    expect(out).not.toContain("Spare");
    expect(out).not.toContain("body.woff)");
    expect(out).toContain(`src: url("data:font/woff2;base64,${WOFF2.toString("base64")}") format("woff2")`);
    expect(ctx.fonts!.dropped).toBe(1);
  });
});
