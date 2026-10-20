import { describe, expect, it } from "vitest";
import type { Resource } from "../resources.ts";
import { inlineCss, inlineUrls, parseImport, resolveCssUrl, type CssContext } from "./css.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

/** A context serving a fixed map of URL -> CSS text or PNG bytes, recording what was asked. */
function site(files: Record<string, string | Buffer>) {
  const asked: string[] = [];
  const warnings: string[] = [];
  const ctx: CssContext = {
    async get(url): Promise<Resource | null> {
      asked.push(url);
      const f = files[url];
      if (f === undefined) return null;
      return typeof f === "string"
        ? { url, mime: "text/css", bytes: Buffer.from(f) }
        : { url, mime: "image/png", bytes: f };
    },
    warn: (m) => warnings.push(m),
  };
  return { ctx, asked, warnings };
}

describe("resolveCssUrl", () => {
  it("resolves against the base and skips what is not fetched", () => {
    expect(resolveCssUrl("../img/a.png", "http://s.test/css/x/site.css")).toBe("http://s.test/css/img/a.png");
    expect(resolveCssUrl("  /a.png ", "http://s.test/css/site.css")).toBe("http://s.test/a.png");
    expect(resolveCssUrl("a\\ b.png", "http://s.test/")).toBe("http://s.test/a%20b.png");
    for (const v of ["", "#grad", "data:image/png;base64,AA", "about:blank", "javascript:x"]) {
      expect(resolveCssUrl(v, "http://s.test/"), v).toBeNull();
    }
  });
});

describe("inlineUrls", () => {
  it("replaces every url() form with a data URI", async () => {
    const { ctx } = site({ "http://s.test/img/a.png": PNG });
    const out = await inlineUrls(`url(img/a.png) url("img/a.png") url( 'img/a.png' )`, "http://s.test/", ctx);
    expect(out).toBe(`url("${PNG_URI}") url("${PNG_URI}") url("${PNG_URI}")`);
  });

  it("sets a missing resource aside: an empty data: URI, its absolute URL in a comment", async () => {
    const { ctx } = site({});
    expect(await inlineUrls(`url(gone.png) no-repeat`, "http://s.test/css/", ctx)).toBe(
      `url("data:,") /* page-archiver unfetched: http://s.test/css/gone.png */ no-repeat`,
    );
  });

  it("cannot end its comment early on a */ in the URL", async () => {
    const { ctx } = site({});
    expect(await inlineUrls(`url("a*/b.png")`, "http://s.test/", ctx)).toBe(`url("data:,") /* page-archiver unfetched: http://s.test/a*%2Fb.png */`);
  });

  it("leaves fragment and data: urls untouched", async () => {
    const { ctx, asked } = site({});
    const text = `url(#clip) url(data:image/png;base64,AA)`;
    expect(await inlineUrls(text, "http://s.test/", ctx)).toBe(text);
    expect(asked).toEqual([]);
  });
});

describe("parseImport", () => {
  it("reads the URL and the layer, supports and media conditions", () => {
    expect(parseImport(`"a.css"`)).toEqual({ url: "a.css", layer: null, supports: null, media: "" });
    expect(parseImport(`url(a.css) screen and (min-width: 600px)`)).toMatchObject({ url: "a.css", media: "screen and (min-width: 600px)" });
    expect(parseImport(`url('a.css') layer(base) supports(display: grid) print`)).toEqual({
      url: "a.css",
      layer: "base",
      supports: "display: grid",
      media: "print",
    });
    expect(parseImport(`"a.css" layer`)).toMatchObject({ layer: "" });
    expect(parseImport(`nonsense`)).toBeNull();
  });
});

describe("inlineCss", () => {
  it("resolves url() against the SHEET's URL, not the page's", async () => {
    const { ctx, asked } = site({ "http://cdn.test/img/paper.png": PNG });
    const out = await inlineCss(`body{background:url(../img/paper.png)}`, "http://cdn.test/css/site.css", ctx);
    expect(asked).toEqual(["http://cdn.test/img/paper.png"]);
    expect(out).toBe(`body{background:url("${PNG_URI}")}`);
  });

  it("inlines an @import chain recursively, each sheet's urls against its own URL", async () => {
    const { ctx, warnings } = site({
      "http://cdn.test/css/a.css": `@import url("nested/b.css");\n.a{background:url(../img/a.png)}`,
      "http://cdn.test/css/nested/b.css": `@import "../../c.css" screen;\n.b{background:url(../../img/b.png)}`,
      "http://cdn.test/c.css": `.c{background:url(img/c.png)}`,
      "http://cdn.test/img/a.png": PNG,
      "http://cdn.test/img/b.png": PNG,
    });
    const out = await inlineCss(`@import "css/a.css";\nh1{color:red}`, "http://cdn.test/page.html", ctx);
    expect(out).not.toMatch(/@import/);
    expect(out).toContain(`.a{background:url("${PNG_URI}")}`);
    expect(out).toContain(`.b{background:url("${PNG_URI}")}`);
    // c.png is not on the site: set aside, its URL resolved against c's own sheet
    expect(out).toMatch(/@media screen\s*\{\s*\.c\{background:url\("data:,"\) \/\* page-archiver unfetched: http:\/\/cdn\.test\/img\/c\.png \*\/\}/);
    // order is the cascade order: c (via b), b, a, then the page's own rule
    const at = (s: string) => out.indexOf(s);
    expect(at(".c{")).toBeLessThan(at(".b{"));
    expect(at(".b{")).toBeLessThan(at(".a{"));
    expect(at(".a{")).toBeLessThan(at("h1{"));
    expect(warnings).toEqual([]);
  });

  it("drops an @import cycle (a -> b -> a) with a warning and still inlines both sheets once", async () => {
    const { ctx, warnings, asked } = site({
      "http://s.test/a.css": `@import "b.css";.a{x:1}`,
      "http://s.test/b.css": `@import "a.css";.b{x:2}`,
    });
    const out = await inlineCss(`@import "a.css";`, "http://s.test/page.html", ctx);
    expect(out.match(/\.a\{/g)).toHaveLength(1);
    expect(out.match(/\.b\{/g)).toHaveLength(1);
    expect(out).not.toMatch(/@import/);
    expect(warnings).toEqual(["http://s.test/b.css: @import http://s.test/a.css is a cycle; dropped"]);
    expect(asked).toEqual(["http://s.test/a.css", "http://s.test/b.css"]);
  });

  it("drops a sheet that imports itself", async () => {
    const { ctx, warnings } = site({ "http://s.test/self.css": `@import "self.css";.s{x:1}` });
    const out = await inlineCss(`@import "self.css";`, "http://s.test/", ctx);
    expect(out).toContain(".s{x:1}");
    expect(warnings).toHaveLength(1);
  });

  it("wraps an import in its layer, supports and media conditions", async () => {
    const { ctx } = site({ "http://s.test/g.css": `.g{display:grid}` });
    const out = await inlineCss(`@import url(g.css) layer(base) supports(display: grid) print;`, "http://s.test/", ctx);
    expect(out).toBe(`@layer base{@supports (display: grid){@media print{.g{display:grid}}}}`);
  });

  it("sets an import it cannot fetch aside as a comment, and drops @charset", async () => {
    const { ctx } = site({});
    const out = await inlineCss(`@charset "utf-8";@import "gone.css" print;.x{y:1}`, "http://s.test/css/", ctx);
    expect(out).toBe(`/* page-archiver unfetched @import: http://s.test/css/gone.css */.x{y:1}`);
  });

  it("inlines url()s in @font-face src", async () => {
    const font = Buffer.from("wOF2font");
    const { ctx } = site({ "http://s.test/f.woff2": font });
    const out = await inlineCss(`@font-face{font-family:F;src:url(f.woff2) format("woff2")}`, "http://s.test/", ctx);
    expect(out).toContain(`src:url("data:image/png;base64,${font.toString("base64")}") format("woff2")`);
  });

  it("survives CSS that does not parse, still inlining its url()s", async () => {
    const { ctx, warnings } = site({ "http://s.test/a.png": PNG });
    const out = await inlineCss(`.x{background:url(a.png)`, "http://s.test/", ctx);
    expect(out).toContain(PNG_URI);
    expect(warnings[0]).toMatch(/did not parse/);
  });
});

describe("image-set() string arguments", () => {
  it("inlines the string arguments of image-set() and -webkit-image-set(), as url() is inlined", async () => {
    const { ctx, asked } = site({ "http://s.test/img/a.png": PNG, "http://s.test/img/b.png": PNG });
    const out = await inlineUrls(
      `image-set("img/a.png" 1x, 'img/b.png' 2x), -webkit-image-set( "../img/a.png" 1x , url(img/b.png) 2x)`,
      "http://s.test/css/../",
      ctx,
    );
    expect(out).toBe(
      `image-set(url("${PNG_URI}") 1x, url("${PNG_URI}") 2x), -webkit-image-set( url("${PNG_URI}") 1x , url("${PNG_URI}") 2x)`,
    );
    expect(asked.sort()).toEqual(["http://s.test/img/a.png", "http://s.test/img/a.png", "http://s.test/img/b.png", "http://s.test/img/b.png"]);
  });

  it("leaves a type() string, a string outside image-set() and a data: string alone; sets a missing one aside", async () => {
    const { ctx, asked } = site({ "http://s.test/a.avif": PNG });
    const text = `image-set("a.avif" type("image/avif"), "gone.png" type("image/png")) /* "x.png" */ "y.png" image-set("data:image/png;base64,AA" 1x)`;
    expect(await inlineUrls(text, "http://s.test/", ctx)).toBe(
      `image-set(url("${PNG_URI}") type("image/avif"), url("data:,") /* page-archiver unfetched: http://s.test/gone.png */ type("image/png")) /* "x.png" */ "y.png" image-set("data:image/png;base64,AA" 1x)`,
    );
    expect(asked.sort()).toEqual(["http://s.test/a.avif", "http://s.test/gone.png"]);
  });

  it("is inlined in a stylesheet's declarations that hold no url() at all", async () => {
    const { ctx } = site({ "http://s.test/img/hero.png": PNG });
    const out = await inlineCss(`.hero { background-image: image-set("../img/hero.png" 1x); }`, "http://s.test/css/site.css", ctx);
    expect(out).toBe(`.hero { background-image: image-set(url("${PNG_URI}") 1x); }`);
  });
});
