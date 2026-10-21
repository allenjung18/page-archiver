import { describe, expect, it } from "vitest";
import type { Resource } from "../resources.ts";
import { hasCssRefs, inlineCss, inlineUrls, parseImport, resolveCssUrl, type CssContext } from "./css.ts";

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

describe("data: stylesheets", () => {
  it("inlines an @import of a data: sheet, its absolute url()s inlined too", async () => {
    const { ctx, asked } = site({ "http://s.test/img/a.png": PNG });
    const b64 = Buffer.from(`.b{background:url("http://s.test/img/a.png")}`).toString("base64");
    const out = await inlineCss(
      `@import url("data:text/css,.a%7Bbackground:url(http://s.test/img/a.png)%7D") print;@import "data:text/css;charset=utf-8;base64,${b64}";.x{y:1}`,
      "http://s.test/css/site.css",
      ctx,
    );
    expect(out, "the percent-encoded sheet, in its media condition").toContain(`@media print{.a{background:url("${PNG_URI}")}}`);
    expect(out, "the base64 sheet").toContain(`.b{background:url("${PNG_URI}")}`);
    expect(out, "no @import left").not.toMatch(/@import/);
    expect(asked).toEqual(["http://s.test/img/a.png", "http://s.test/img/a.png"]);
  });

  it("sets a relative url() in a data: sheet aside: it names nothing live, and from disk it would name a file", async () => {
    const { ctx, asked } = site({ "http://s.test/img/a.png": PNG });
    const out = await inlineCss(`.a{background:url(img/a.png),url(#g)}`, "data:text/css,.a%7B%7D", ctx);
    expect(out).toBe(`.a{background:url("data:,"),url(#g)}`);
    expect(asked).toEqual([]);
  });

  it("decodes a large base64 data: sheet (an embedded font's worth)", async () => {
    const { ctx } = site({});
    const css = `.a{b:c}/*${"x".repeat(300_000)}*/`;
    const out = await inlineCss(`@import url("data:text/css;base64,${Buffer.from(css).toString("base64")}");`, "http://s.test/", ctx);
    expect(out.startsWith(".a{b:c}/*xxx")).toBe(true);
    expect(out.length).toBe(css.length);
  });

  it("in a quirks-mode document, imports a data: sheet of any type, as a browser does", async () => {
    const { ctx } = site({ "http://s.test/a.png": PNG });
    ctx.quirks = true;
    const out = await inlineCss(`@import url("data:,.a%7Bbackground:url(http://s.test/a.png)%7D");`, "http://s.test/", ctx);
    expect(out).toBe(`.a{background:url("${PNG_URI}")}`);
  });

  it("leaves a data: import that is not text/css out, as a browser does", async () => {
    const { ctx, warnings } = site({});
    const out = await inlineCss(`@import url("data:text/plain,.a%7Bb:c%7D");.x{y:1}`, "http://s.test/", ctx);
    expect(out).toBe(`.x{y:1}`);
    expect(warnings[0]).toMatch(/not understood; dropped$/);
  });
});

describe("CSS that does not parse", () => {
  it("sets every @import aside, string or url() form, and inlines the url()s", async () => {
    const { ctx, asked, warnings } = site({ "http://s.test/css/b.css": `.b{}`, "http://s.test/css/a.png": PNG });
    const out = await inlineCss(
      `@import "gone.css";@IMPORT url(b.css) print;/* @import "c.css"; */.q{content:"@import 'd.css';"}.x{background:url(a.png)`,
      "http://s.test/css/site.css",
      ctx,
    );
    expect(out, "the string-form @import is set aside").toContain(`/* page-archiver unfetched @import: http://s.test/css/gone.css */`);
    expect(out, "the url() form too, not inlined as a sheet of its own").toContain(`/* page-archiver unfetched @import: http://s.test/css/b.css */`);
    expect(out, "a comment and a string are not rules").toContain(`/* @import "c.css"; */.q{content:"@import 'd.css';"}`);
    expect(out).toContain(PNG_URI);
    expect(asked).toEqual(["http://s.test/css/a.png"]);
    expect(warnings[0]).toMatch(/did not parse .*; url\(\)s inlined, @import set aside$/);
  });

  it("sets aside an @import whose name is written with CSS escapes, as Chromium reads it", async () => {
    // postcss cannot parse "@\69mport" (an at-rule with no name); Chromium reads it as @import
    const { ctx, asked } = site({ "http://s.test/css/b.css": `.b{}`, "http://s.test/css/a.png": PNG });
    const out = await inlineCss(
      String.raw`@\69mport "gone.css";@\69 mport url(b.css) print;@IMPOR\54 "c.css";@\69mportant "d.css";.x{background:url(a.png)}`,
      "http://s.test/css/site.css",
      ctx,
    );
    expect(out, "the \\69 escape").toContain(`/* page-archiver unfetched @import: http://s.test/css/gone.css */`);
    expect(out, "an escape ended by a space, url() form").toContain(`/* page-archiver unfetched @import: http://s.test/css/b.css */`);
    expect(out, "an escape at the end of the name").toContain(`/* page-archiver unfetched @import: http://s.test/css/c.css */`);
    expect(out, "an at-rule that only starts like one is left alone").toContain(String.raw`@\69mportant "d.css";`);
    expect(asked, "the url() form is not inlined as a sheet").toEqual(["http://s.test/css/a.png"]);
  });
});

describe("an @import whose name is written with CSS escapes", () => {
  it("is inlined as any @import when postcss reads it as another at-rule", async () => {
    // postcss stops an at-rule name at a backslash: "@i\6dport" is an at-rule "i" with params "\6dport …"
    const { ctx, asked } = site({ "http://s.test/css/b.css": `.b{}`, "http://s.test/css/c.css": `.c{}` });
    const out = await inlineCss(String.raw`@i\6dport "b.css";@im\port url(c.css) print;@m\65 dia print{.y{z:1}}.x{y:1}`, "http://s.test/css/site.css", ctx);
    expect(out, "the hex escape").toContain(`.b{}`);
    expect(out, "the escape of a plain letter, in its media condition").toContain(`@media print{.c{}}`);
    expect(out, "no escaped @import left to fetch").not.toMatch(/@i\\6dport|@im\\port/);
    expect(out, "an escaped name that is not import is left as it came").toContain(String.raw`@m\65 dia print{.y{z:1}}`);
    expect(asked).toEqual(["http://s.test/css/b.css", "http://s.test/css/c.css"]);
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

describe("a url() or image-set() whose name is written with CSS escapes", () => {
  // Chromium decodes escapes in a function's name: "\75rl(" is a url(, "image-s\65t(" an image-set(
  it("inlines a url() named with hex escapes, an escape ended by a space, or an escaped plain letter", async () => {
    const { ctx, asked } = site({ "http://s.test/a.png": PNG });
    const text = String.raw`\75rl(a.png) u\72l("a.png") \55 RL( 'a.png' ) \75 \72 \6c (a.png) \url(a.png)`;
    expect(await inlineUrls(text, "http://s.test/", ctx)).toBe(Array(5).fill(`url("${PNG_URI}")`).join(" "));
    expect(asked).toHaveLength(5);
  });

  it("leaves a name that only contains or starts like url alone, as the tokenizer reads names whole", async () => {
    const { ctx, asked } = site({ "http://s.test/a.png": PNG });
    const text = String.raw`myurl(a.png) \75rls(a.png) 10url(a.png) my\75rl(a.png)`;
    expect(await inlineUrls(text, "http://s.test/", ctx)).toBe(text);
    expect(asked).toEqual([]);
  });

  it("inlines the strings of an image-set() named with escapes, and tells hasCssRefs about both", async () => {
    const { ctx } = site({ "http://s.test/a.png": PNG });
    const text = String.raw`image-s\65t("a.png" 1x), -webkit-im\61ge-set('a.png' 2x), \69mage-set("a.png" 1x)`;
    expect(await inlineUrls(text, "http://s.test/", ctx)).toBe(
      String.raw`image-s\65t(url("${PNG_URI}") 1x), -webkit-im\61ge-set(url("${PNG_URI}") 2x), \69mage-set(url("${PNG_URI}") 1x)`,
    );
    expect(hasCssRefs(String.raw`background: \75rl(a.png)`)).toBe(true);
    expect(hasCssRefs(String.raw`background: image-s\65t("a.png" 1x)`)).toBe(true);
    expect(hasCssRefs(String.raw`content: "\2014"; font-family: \66oo`)).toBe(false);
  });

  it("inlines one in a stylesheet's declarations, in an @import, and in CSS that does not parse", async () => {
    const { ctx, asked } = site({ "http://s.test/css/a.png": PNG, "http://s.test/css/b.css": String.raw`.b{background:U\52L(a.png)}` });
    const out = await inlineCss(String.raw`@import \75rl(b.css);.x{background:\75rl(a.png) no-repeat}`, "http://s.test/css/site.css", ctx);
    expect(out).toBe(`.b{background:url("${PNG_URI}")}.x{background:url("${PNG_URI}") no-repeat}`);
    expect(asked.sort()).toEqual(["http://s.test/css/a.png", "http://s.test/css/a.png", "http://s.test/css/b.css"]);

    const broken = await inlineCss(String.raw`@\69mport u\72l(gone.css);.x{background:\75rl(a.png)`, "http://s.test/css/site.css", site({ "http://s.test/css/a.png": PNG }).ctx);
    expect(broken, "the @import's URL is read").toContain(`/* page-archiver unfetched @import: http://s.test/css/gone.css */`);
    expect(broken).toContain(`.x{background:url("${PNG_URI}")`);
  });

  it("narrows a font's src list to the escaped url() the browser fetched, as a plain one is", async () => {
    const font = Buffer.from("wOF2font");
    const { ctx, asked } = site({ "http://s.test/f.woff2": font, "http://s.test/f.woff": font });
    ctx.fetched = (url) => url === "http://s.test/f.woff2";
    const out = await inlineCss(String.raw`@font-face{font-family:F;src:local(F), \75rl(f.woff2) format("woff2"), url(f.woff) format("woff")}`, "http://s.test/", ctx);
    expect(out).toBe(`@font-face{font-family:F;src:local(F), url("data:image/png;base64,${font.toString("base64")}") format("woff2")}`);
    expect(asked, "the src the browser did not fetch is not fetched for the archive").toEqual(["http://s.test/f.woff2"]);
  });
});
