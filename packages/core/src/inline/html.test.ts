import { describe, expect, it } from "vitest";
import { allElements, getAttr, parseDocument, serializeDocument } from "../dom.ts";
import type { Resource } from "../resources.ts";
import {
  absoluteLink,
  inlineDocument,
  MEDIA_SRC_ATTRIBUTE,
  POSTER_FRAME_ATTRIBUTE,
  SPRITE_ID_PREFIX,
  SPRITES_ATTRIBUTE,
  UNFETCHED_ATTRIBUTE_PREFIX,
  VIDEO_RATIO_ATTRIBUTE,
  type HtmlContext,
} from "./html.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

/** A file served with its own MIME type (a bare string is CSS, a Buffer a PNG). */
interface Typed {
  mime: string;
  body: string | Buffer;
}

type Files = Record<string, string | Buffer | Typed>;

function ctxFor(files: Files, baseUrl = "http://site.test/blog/post.html") {
  const warnings: string[] = [];
  const requested: string[] = [];
  const ctx: HtmlContext = {
    baseUrl,
    async get(url): Promise<Resource | null> {
      requested.push(url);
      const f = files[url];
      if (f === undefined) return null;
      if (typeof f === "string") return { url, mime: "text/css", bytes: Buffer.from(f) };
      if (Buffer.isBuffer(f)) return { url, mime: "image/png", bytes: f };
      return { url, mime: f.mime, bytes: Buffer.from(f.body) };
    },
    warn: (m) => warnings.push(m),
  };
  return { ctx, warnings, requested };
}

async function run(html: string, files: Files, baseUrl?: string, pageUrl?: string) {
  const doc = parseDocument(html);
  const { ctx, warnings, requested } = ctxFor(files, baseUrl);
  if (pageUrl) ctx.pageUrl = pageUrl;
  await inlineDocument(doc, ctx);
  return { doc, out: serializeDocument(doc), warnings, requested };
}

const byId = (doc: ReturnType<typeof parseDocument>, id: string) => allElements(doc).find((e) => getAttr(e, "id") === id)!;

describe("inlineDocument", () => {
  it("replaces a stylesheet link with a <style>, url()s resolved against the sheet", async () => {
    const { out } = await run(`<link rel="stylesheet" media="screen" href="http://cdn.test/css/a.css"><p>x</p>`, {
      "http://cdn.test/css/a.css": `body{background:url(../img/p.png)}`,
      "http://cdn.test/img/p.png": PNG,
    });
    expect(out).not.toContain("<link");
    expect(out).toContain(`<style media="screen">body{background:url("${PNG_URI}")}</style>`);
  });

  it("sets a stylesheet it cannot fetch aside: no href, the absolute URL kept beside it", async () => {
    const { out } = await run(`<link rel="stylesheet" href="/gone.css">`, {});
    expect(out).toContain(`<link rel="stylesheet" ${UNFETCHED_ATTRIBUTE_PREFIX}href="http://site.test/gone.css">`);
  });

  it("sets every resource attribute it cannot fetch aside, so nothing in the file names the network", async () => {
    const { doc, out } = await run(
      `<img id="i" src="gone.png" alt="a"><input id="n" type="image" src="/gone-button.png">` +
        `<table id="t" background="/gone-bg.png"></table>` +
        `<svg><image id="s" href="/gone.svg"></image><filter><feImage id="f" href="/gone-fe.png"></feImage></filter></svg>` +
        `<div id="d" style="background: url(/gone-style.png) no-repeat"></div>`,
      {},
    );
    expect(getAttr(byId(doc, "i"), "src")).toBeNull();
    expect(getAttr(byId(doc, "i"), `${UNFETCHED_ATTRIBUTE_PREFIX}src`)).toBe("http://site.test/blog/gone.png");
    expect(getAttr(byId(doc, "n"), `${UNFETCHED_ATTRIBUTE_PREFIX}src`)).toBe("http://site.test/gone-button.png");
    expect(getAttr(byId(doc, "t"), `${UNFETCHED_ATTRIBUTE_PREFIX}background`)).toBe("http://site.test/gone-bg.png");
    expect(getAttr(byId(doc, "s"), `${UNFETCHED_ATTRIBUTE_PREFIX}href`)).toBe("http://site.test/gone.svg");
    expect(getAttr(byId(doc, "f"), `${UNFETCHED_ATTRIBUTE_PREFIX}href`)).toBe("http://site.test/gone-fe.png");
    expect(getAttr(byId(doc, "d"), "style")).toBe(`background: url("data:,") /* page-archiver unfetched: http://site.test/gone-style.png */ no-repeat`);
    // the only http(s) URLs left are in the set-aside attributes and comments
    const live = out.replace(new RegExp(`${UNFETCHED_ATTRIBUTE_PREFIX}[a-z]+="[^"]*"`, "g"), "").replace(/\/\*[^]*?\*\//g, "");
    expect(live).not.toMatch(/https?:/);
  });

  it("replaces a data: stylesheet link with a <style>, its absolute url()s inlined", async () => {
    const { out, requested } = await run(
      `<link rel="stylesheet" media="print" href="data:text/css,body%7Bbackground:url('http://cdn.test/img/p.png')%7D">`,
      { "http://cdn.test/img/p.png": PNG },
    );
    expect(out).toContain(`<style media="print">body{background:url("${PNG_URI}")}</style>`);
    expect(out, "no link left").not.toContain("<link");
    expect(requested).toEqual(["http://cdn.test/img/p.png"]);
  });

  it("leaves a data: link that is not text/css as it is in a standards-mode page: a browser does not apply it", async () => {
    const { out, requested } = await run(`<!doctype html><link rel="stylesheet" href="data:,body%7Bbackground:url(http://cdn.test/img/p.png)%7D">`, {
      "http://cdn.test/img/p.png": PNG,
    });
    expect(out).toContain(`<link rel="stylesheet" href="data:,body%7Bbackground:url(http://cdn.test/img/p.png)%7D">`);
    expect(requested).toEqual([]);
  });

  it("inlines a data: link of any type in a quirks-mode page, which a browser applies", async () => {
    const { out } = await run(`<link rel="stylesheet" href="data:,body%7Bbackground:url(http://cdn.test/img/p.png)%7D">`, {
      "http://cdn.test/img/p.png": PNG,
    });
    expect(out).toContain(`<style>body{background:url("${PNG_URI}")}</style>`);
    expect(out, "no link left to load from disk").not.toContain("<link");
  });

  it("drops an alternate stylesheet with a warning", async () => {
    const { out, warnings } = await run(`<link rel="alternate stylesheet" href="/alt.css">`, { "http://site.test/alt.css": "a{}" });
    expect(out).not.toContain("alt.css");
    expect(warnings).toHaveLength(1);
  });

  it("inlines <style> text against the page's base URL", async () => {
    const { out } = await run(`<style>.x{background:url(img/a.png)}</style>`, { "http://site.test/blog/img/a.png": PNG });
    expect(out).toContain(`.x{background:url("${PNG_URI}")}`);
  });

  it("inlines url()s in style attributes", async () => {
    const { doc } = await run(`<div id="d" style="background-image: url('/a.png'); color: red"></div>`, { "http://site.test/a.png": PNG });
    expect(getAttr(byId(doc, "d"), "style")).toBe(`background-image: url("${PNG_URI}"); color: red`);
  });

  it("inlines the string arguments of image-set() in style attributes, with no url() in them", async () => {
    const { doc, requested } = await run(`<div id="d" style="background-image: -webkit-image-set('/a.png' 1x)"></div>`, { "http://site.test/a.png": PNG });
    expect(getAttr(byId(doc, "d"), "style")).toBe(`background-image: -webkit-image-set(url("${PNG_URI}") 1x)`);
    expect(requested).toEqual(["http://site.test/a.png"]);
  });

  it("inlines img src and drops srcset, sizes and loading", async () => {
    const { doc } = await run(`<img id="i" src="../a.png" srcset="../a.png 1x" sizes="10px" loading="lazy" alt="a">`, { "http://site.test/a.png": PNG });
    const img = byId(doc, "i");
    expect(getAttr(img, "src")).toBe(PNG_URI);
    expect(img.attrs.map((a) => a.name).sort()).toEqual(["alt", "id", "src"]);
  });

  it("sets an image it cannot fetch aside, its src absolute", async () => {
    const { doc } = await run(`<img id="i" src="gone.png">`, {});
    expect(getAttr(byId(doc, "i"), "src")).toBeNull();
    expect(getAttr(byId(doc, "i"), `${UNFETCHED_ATTRIBUTE_PREFIX}src`)).toBe("http://site.test/blog/gone.png");
  });

  it("inlines video posters, input images, SVG image hrefs and favicons; drops a favicon it cannot fetch", async () => {
    const files = { "http://site.test/p.png": PNG };
    const { doc, out } = await run(
      `<link id="icon" rel="icon" href="/p.png"><link id="gone" rel="shortcut icon" href="/missing.ico"><video id="v" poster="/p.png"></video><input id="in" type="image" src="/p.png"><svg><image id="s" href="/p.png"></image></svg>`,
      files,
    );
    expect(getAttr(byId(doc, "icon"), "href")).toBe(PNG_URI);
    expect(out).not.toContain("missing.ico");
    expect(getAttr(byId(doc, "v"), "poster")).toBe(PNG_URI);
    expect(getAttr(byId(doc, "in"), "src")).toBe(PNG_URI);
    expect(getAttr(byId(doc, "s"), "href")).toBe(PNG_URI);
  });

  it("inlines an SVG image into both its href and its xlink:href, which a browser would read the plain one of", async () => {
    const files = { "http://cdn.test/a.png": PNG };
    const { doc, out } = await run(
      `<svg><image id="s" xlink:href="https://cdn.test/a.png" href="http://cdn.test/a.png"></image>` +
        `<filter><feImage id="f" xlink:href="http://cdn.test/a.png" href="http://cdn.test/a.png"></feImage></filter>` +
        `<image id="g" xlink:href="http://cdn.test/gone-x.png" href="http://cdn.test/gone.png"></image></svg>`,
      files,
    );
    for (const id of ["s", "f"]) {
      const hrefs = byId(doc, id).attrs.filter((a) => a.name === "href");
      expect(hrefs.map((a) => a.value), id).toEqual([PNG_URI, PNG_URI]);
    }
    // the one that cannot be had is set aside under the URL the browser would have fetched, every href gone
    expect(byId(doc, "g").attrs.filter((a) => a.name === "href")).toEqual([]);
    expect(getAttr(byId(doc, "g"), `${UNFETCHED_ATTRIBUTE_PREFIX}href`)).toBe("http://cdn.test/gone.png");
    const live = out.replace(new RegExp(`${UNFETCHED_ATTRIBUTE_PREFIX}[a-z]+="[^"]*"`, "g"), "");
    expect(live).not.toMatch(/https?:/);
  });

  it("leaves an feImage naming an element of the page as it is, never fetching the page itself", async () => {
    const { doc, requested } = await run(`<svg><circle id="dot" r="2"/><filter><feImage id="f" href="#dot"></feImage></filter></svg>`, {});
    expect(getAttr(byId(doc, "f"), "href")).toBe("#dot");
    expect(requested).toEqual([]);
  });

  it("inlines every icon rel the browser fetches, apple-touch-icon-precomposed included", async () => {
    const files = { "http://site.test/p.png": PNG };
    const { doc, out } = await run(
      `<link id="a" rel="apple-touch-icon" href="/p.png"><link id="b" rel="apple-touch-icon-precomposed" sizes="57x57" href="/p.png"><link id="c" rel="apple-touch-icon-precomposed" href="/gone-76.png">`,
      files,
    );
    expect(getAttr(byId(doc, "a"), "href")).toBe(PNG_URI);
    expect(getAttr(byId(doc, "b"), "href")).toBe(PNG_URI);
    expect(out).not.toContain("gone-76.png");
  });

  it("sets video and audio media aside: no src left, the address kept in data-page-archiver-src, one warning per element", async () => {
    const { doc, out, warnings } = await run(
      `<video id="v" autoplay muted loop src="/clip.mp4"></video>` +
        `<video id="w" poster="/missing-poster.png"><source id="s1" src="https://cdn.test/a.webm" type="video/webm"><source id="s2" src="b.mp4"><track id="t" src="/subs.vtt"></video>` +
        `<audio id="a" src="blob:http://site.test/0b1c"></audio>` +
        `<video id="d" src="data:video/webm;base64,AAAA"></video><video id="none"></video>`,
      {},
    );
    expect(out).not.toMatch(/\ssrc="(?!data:)/);
    expect(getAttr(byId(doc, "v"), MEDIA_SRC_ATTRIBUTE)).toBe("http://site.test/clip.mp4");
    expect(getAttr(byId(doc, "s1"), MEDIA_SRC_ATTRIBUTE)).toBe("https://cdn.test/a.webm");
    expect(getAttr(byId(doc, "s2"), MEDIA_SRC_ATTRIBUTE)).toBe("http://site.test/blog/b.mp4");
    expect(getAttr(byId(doc, "t"), MEDIA_SRC_ATTRIBUTE)).toBe("http://site.test/subs.vtt");
    expect(getAttr(byId(doc, "a"), MEDIA_SRC_ATTRIBUTE)).toBe("blob:http://site.test/0b1c");
    // a data: source is inside the file already and stays
    expect(getAttr(byId(doc, "d"), "src")).toBe("data:video/webm;base64,AAAA");
    expect(warnings).toEqual([
      "video http://site.test/clip.mp4: media not archived; it has no poster frame",
      "video https://cdn.test/a.webm: media not archived; the poster frame is kept",
      "audio blob:http://site.test/0b1c: media not archived; nothing of it is kept",
      // the poster could not be had: set aside, like any image
    ]);
    expect(getAttr(byId(doc, "w"), "poster")).toBeNull();
    expect(getAttr(byId(doc, "w"), `${UNFETCHED_ATTRIBUTE_PREFIX}poster`)).toBe("http://site.test/missing-poster.png");
  });

  it("makes a video's captured frame its poster, over the page's own poster, and only a data: image", async () => {
    const frame = "data:image/png;base64,iVBORw0KGgo=";
    const { doc, out } = await run(
      `<video id="v" src="/clip.mp4" ${POSTER_FRAME_ATTRIBUTE}="${frame}" poster="/p.png"></video>` +
        `<video id="x" ${POSTER_FRAME_ATTRIBUTE}="https://evil.test/track.png"></video>` +
        `<audio id="a" ${POSTER_FRAME_ATTRIBUTE}="${frame}"></audio>`,
      { "http://site.test/p.png": PNG },
    );
    expect(getAttr(byId(doc, "v"), "poster")).toBe(frame);
    expect(getAttr(byId(doc, "x"), "poster")).toBeNull();
    expect(getAttr(byId(doc, "a"), "poster")).toBeNull();
    expect(out).not.toContain(POSTER_FRAME_ATTRIBUTE);
  });

  it("gives a video with a poster frame its own aspect ratio, and only a well-formed one", async () => {
    const frame = "data:image/png;base64,iVBORw0KGgo=";
    const { doc, out } = await run(
      `<video id="a" ${POSTER_FRAME_ATTRIBUTE}="${frame}" ${VIDEO_RATIO_ATTRIBUTE}="444 / 962"></video>` +
        `<video id="b" style="width:50%;background:url(/p.png)" ${POSTER_FRAME_ATTRIBUTE}="${frame}" ${VIDEO_RATIO_ATTRIBUTE}="16 / 9"></video>` +
        `<video id="c" ${POSTER_FRAME_ATTRIBUTE}="${frame}" ${VIDEO_RATIO_ATTRIBUTE}="1;background:url(https://x.test/)"></video>` +
        `<video id="d" ${VIDEO_RATIO_ATTRIBUTE}="16 / 9"></video>`,
      { "http://site.test/p.png": PNG },
    );
    expect(getAttr(byId(doc, "a"), "style")).toBe("aspect-ratio: 444 / 962");
    expect(getAttr(byId(doc, "b"), "style")).toBe(`width:50%;background:url("${PNG_URI}"); aspect-ratio: 16 / 9`);
    expect(getAttr(byId(doc, "c"), "style")).toBeNull();
    // no poster frame, no ratio: the box is whatever the page's CSS makes it
    expect(getAttr(byId(doc, "d"), "style")).toBeNull();
    expect(out).not.toContain(VIDEO_RATIO_ATTRIBUTE);
  });

  it("makes links absolute against the base URL, leaving in-page anchors alone", async () => {
    const { doc } = await run(
      `<a id="rel" href="../other.html">r</a><a id="root" href="/x?a=1&b=2">x</a><a id="frag" href="#notes">n</a><a id="abs" href="https://example.com/">e</a><a id="mail" href="mailto:a@b.test">m</a><form id="f" action="search"></form><link id="canon" rel="canonical" href="/canonical">`,
      {},
    );
    expect(getAttr(byId(doc, "rel"), "href")).toBe("http://site.test/other.html");
    expect(getAttr(byId(doc, "root"), "href")).toBe("http://site.test/x?a=1&b=2");
    expect(getAttr(byId(doc, "frag"), "href")).toBe("#notes");
    expect(getAttr(byId(doc, "abs"), "href")).toBe("https://example.com/");
    expect(getAttr(byId(doc, "mail"), "href")).toBe("mailto:a@b.test");
    expect(getAttr(byId(doc, "f"), "action")).toBe("http://site.test/blog/search");
    expect(getAttr(byId(doc, "canon"), "href")).toBe("http://site.test/canonical");
  });

  it("leaves data: images alone", async () => {
    const { doc } = await run(`<img id="i" src="${PNG_URI}">`, {});
    expect(getAttr(byId(doc, "i"), "src")).toBe(PNG_URI);
  });
});

const SVG = "image/svg+xml";
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#c33"/></svg>`;
const SPRITE = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#36c"/></linearGradient></defs>
  <symbol id="a" viewBox="0 0 10 10" onload="steal()"><path d="M0 0h10v10z" fill="url(#g)"/><use xlink:href="#dot"/><image href="pic.png" width="2" height="2"/><script>steal()</script></symbol>
  <symbol id="dot" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></symbol>
  <symbol id="unused" viewBox="0 0 2 2"><rect width="2" height="2"/></symbol>
</svg>`;

describe("inlineDocument: <object> and <embed>", () => {
  it("makes an image in an <object> or <embed> an <img> of it, keeping its other attributes", async () => {
    const { doc, out, warnings } = await run(
      `<object id="o" class="fig" data="/img/chart.png" type="image/png" width="40" height="20" data-page-archiver-frame="f1">fallback</object>` +
        `<embed id="e" src="http://cdn.test/badge.svg" type="image/svg+xml" width="8" height="8">` +
        `<object id="u" data="/img/untyped.png"></object>`,
      {
        "http://site.test/img/chart.png": PNG,
        "http://cdn.test/badge.svg": { mime: SVG, body: BADGE },
        "http://site.test/img/untyped.png": { mime: "application/octet-stream", body: PNG },
      },
    );
    expect(out).not.toMatch(/<object|<embed/);
    expect(out, "no address left that the archive would fetch").not.toMatch(/(site|cdn)\.test/);
    const o = byId(doc, "o");
    expect(o.tagName).toBe("img");
    expect(getAttr(o, "src")).toBe(PNG_URI);
    expect(o.attrs.map((a) => a.name)).toEqual(["id", "class", "width", "height", "data-page-archiver-frame", "src"]);
    expect(getAttr(byId(doc, "e"), "src")).toMatch(/^data:image\/svg\+xml;charset=utf-8;base64,/);
    expect(getAttr(byId(doc, "u"), "src"), "an untyped image is sniffed").toBe(PNG_URI);
    expect(warnings).toEqual([]);
  });

  it("gives the <img> its style and background inlined, whichever fetch ends first", async () => {
    const slowBg: Files = { "http://site.test/bg.png": PNG, "http://site.test/a.png": PNG };
    const doc = parseDocument(`<object id="o" data="/a.png" type="image/png" style="background: url(/bg.png) no-repeat" background="/bg.png"></object>`);
    const { ctx } = ctxFor(slowBg);
    const get = ctx.get.bind(ctx);
    // the background arrives after the object's own image
    ctx.get = async (url) => (url.endsWith("/bg.png") ? new Promise((r) => setTimeout(() => r(get(url)), 20)) : get(url));
    await inlineDocument(doc, ctx);
    const o = byId(doc, "o");
    expect(o.tagName).toBe("img");
    expect(getAttr(o, "style")).toBe(`background: url("${PNG_URI}") no-repeat`);
    expect(getAttr(o, "background")).toBe(PNG_URI);
  });

  it("sets aside an untyped <object> or <embed> whose file is plainly not an image, without fetching it", async () => {
    const { doc, warnings, requested } = await run(`<embed id="e" src="/files/big.pdf"><object id="o" data="/movie.swf?v=2"></object>`, {});
    expect(requested).toEqual([]);
    expect(getAttr(byId(doc, "e"), `${UNFETCHED_ATTRIBUTE_PREFIX}src`)).toBe("http://site.test/files/big.pdf");
    expect(getAttr(byId(doc, "o"), `${UNFETCHED_ATTRIBUTE_PREFIX}data`)).toBe("http://site.test/movie.swf?v=2");
    expect(warnings).toEqual([
      "embed http://site.test/files/big.pdf: a .pdf file is not an image; set aside",
      "object http://site.test/movie.swf?v=2: a .swf file is not an image; set aside",
    ]);
  });

  it("sets aside what is not an image, with a warning, and never puts a data: document into the element", async () => {
    const { doc, out, warnings, requested } = await run(
      `<object id="doc" data="/pages/inner"><p>fallback</p></object>` +
        `<embed id="pdf" src="/files/report.pdf" type="application/pdf">` +
        `<object id="gone" data="/img/gone.png" type="image/png">fallback</object>`,
      { "http://site.test/pages/inner": { mime: "text/html; charset=utf-8", body: "<p>inner</p>" } },
    );
    expect(getAttr(byId(doc, "doc"), "data")).toBeNull();
    expect(getAttr(byId(doc, "doc"), `${UNFETCHED_ATTRIBUTE_PREFIX}data`)).toBe("http://site.test/pages/inner");
    expect(getAttr(byId(doc, "pdf"), "src")).toBeNull();
    expect(getAttr(byId(doc, "pdf"), `${UNFETCHED_ATTRIBUTE_PREFIX}src`)).toBe("http://site.test/files/report.pdf");
    expect(getAttr(byId(doc, "pdf"), "type"), "a type alone still starts a plugin").toBeNull();
    expect(getAttr(byId(doc, "pdf"), `${UNFETCHED_ATTRIBUTE_PREFIX}type`)).toBe("application/pdf");
    expect(getAttr(byId(doc, "gone"), "type")).toBeNull();
    expect(getAttr(byId(doc, "gone"), `${UNFETCHED_ATTRIBUTE_PREFIX}data`)).toBe("http://site.test/img/gone.png");
    expect(byId(doc, "gone").tagName, "an image that cannot be had keeps its fallback").toBe("object");
    expect(out).not.toMatch(/\s(data|src)="/);
    expect(out).not.toContain("data:text/html");
    expect(requested, "a declared non-image is not fetched").not.toContain("http://site.test/files/report.pdf");
    expect(warnings).toEqual([
      "embed http://site.test/files/report.pdf: application/pdf is not an image; set aside",
      "object http://site.test/pages/inner: text/html is not an image; set aside",
    ]);
  });
});

describe("inlineDocument: SVG <use> of an external sprite", () => {
  const files: Files = {
    "http://cdn.test/icons/sprite.svg": { mime: SVG, body: SPRITE },
    "http://cdn.test/icons/pic.png": PNG,
  };

  it("copies the element, and what it refers to, into the document and points the <use> at the copy", async () => {
    const { doc, out, warnings } = await run(
      `<p id="g">the page's own #g</p>` +
        `<svg><use id="u1" href="http://cdn.test/icons/sprite.svg#a"></use></svg>` +
        `<svg><use id="u2" xlink:href="//cdn.test/icons/sprite.svg#a"/></svg><footer>end</footer>`,
      files,
    );
    const local = `#${SPRITE_ID_PREFIX}0-a`;
    expect(getAttr(byId(doc, "u1"), "href")).toBe(local);
    expect(getAttr(byId(doc, "u2"), "href"), "xlink:href too").toBe(local);
    expect(out).toContain(`<use id="u2" xlink:href="${local}">`);
    expect(out, "no address left that the archive would fetch").not.toContain("cdn.test");
    // copied once for both, with the gradient and the symbol it uses, renamed; not the unused one
    expect(out.split(`id="${SPRITE_ID_PREFIX}0-a"`)).toHaveLength(2);
    expect(out).toContain(`fill="url(#${SPRITE_ID_PREFIX}0-g)"`);
    expect(out).toContain(`<linearGradient id="${SPRITE_ID_PREFIX}0-g">`);
    expect(out).toContain(`<use xlink:href="#${SPRITE_ID_PREFIX}0-dot">`);
    expect(out).toContain(`<symbol id="${SPRITE_ID_PREFIX}0-dot" viewBox="0 0 2 2">`);
    expect(out).not.toContain("unused");
    expect(getAttr(byId(doc, "g"), "id"), "the page's own ids are untouched").toBe("g");
    // what the copy refers to is inlined against the sprite's URL, and the sprite is sanitized
    expect(out).toContain(`<image href="${PNG_URI}"`);
    expect(out).not.toMatch(/<script|onload|steal/);
    // the copies sit in one hidden <svg> at the end of <body>
    const body = allElements(doc).find((e) => e.tagName === "body")!;
    const last = body.childNodes.at(-1)!;
    expect("tagName" in last && last.tagName).toBe("svg");
    expect(getAttr(last as never, SPRITES_ATTRIBUTE)).toBe("");
    expect(warnings).toEqual([]);
  });

  it("takes a sprite served as XML, as Chromium does, and reads a plain href over xlink:href", async () => {
    const { doc, out, warnings } = await run(
      `<svg><use id="u" xlink:href="#a" href="http://cdn.test/x/sprite.xml#dot"></use></svg>`,
      { "http://cdn.test/x/sprite.xml": { mime: "application/xml", body: SPRITE } },
    );
    expect(warnings).toEqual([]);
    expect(out).not.toContain("cdn.test");
    for (const a of byId(doc, "u").attrs.filter((x) => x.name === "href")) expect(a.value).toBe(`#${SPRITE_ID_PREFIX}0-dot`);
  });

  it("copies into the shadow root the <use> is in, where its ids are scoped", async () => {
    const { out } = await run(
      `<div><template shadowrootmode="open"><svg><use href="http://cdn.test/icons/sprite.svg#dot"></use></svg></template></div>`,
      files,
    );
    expect(out).toMatch(new RegExp(`<template shadowrootmode="open">.*<svg ${SPRITES_ATTRIBUTE}="".*id="${SPRITE_ID_PREFIX}0-dot".*</template>`, "s"));
  });

  it("sets aside a <use> whose file cannot be had, is not SVG, or has no such element, with a warning", async () => {
    const { doc, out, warnings } = await run(
      `<svg><use id="gone" href="http://cdn.test/gone.svg#a"/><use id="html" href="http://cdn.test/page.html#a"/>` +
        `<use id="none" href="http://cdn.test/icons/sprite.svg#zz"/><use id="whole" href="http://cdn.test/icons/sprite.svg"/>` +
        `<use id="here" href="#a"/></svg>`,
      { ...files, "http://cdn.test/page.html": { mime: "text/html", body: `<svg><symbol id="a"></symbol></svg>` } },
    );
    for (const [id, url] of [
      ["gone", "http://cdn.test/gone.svg#a"],
      ["html", "http://cdn.test/page.html#a"],
      ["none", "http://cdn.test/icons/sprite.svg#zz"],
      ["whole", "http://cdn.test/icons/sprite.svg"],
    ]) {
      expect(getAttr(byId(doc, id!), "href"), id).toBeNull();
      expect(getAttr(byId(doc, id!), `${UNFETCHED_ATTRIBUTE_PREFIX}href`), id).toBe(url);
    }
    expect(getAttr(byId(doc, "here"), "href"), "an in-page reference is left alone").toBe("#a");
    expect(out).not.toContain(SPRITES_ATTRIBUTE);
    expect(warnings.sort()).toEqual(
      [
        "use http://cdn.test/icons/sprite.svg: names no element of the file; set aside",
        'use http://cdn.test/icons/sprite.svg#zz: the file has no element with id "zz"; set aside',
        "use http://cdn.test/page.html#a: text/html is not an SVG file; set aside",
      ].sort(),
    );
  });
});

const FX = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#36c"/></linearGradient></defs>
  <filter id="soft"><feGaussianBlur stdDeviation="2"/></filter>
  <mask id="fade"><rect width="10" height="10" fill="url(#g)"/></mask>
  <clipPath id="half"><rect width="5" height="10"/></clipPath>
  <marker id="arrow" markerWidth="4" markerHeight="4"><path d="M0 0L4 2L0 4z" filter="url(more.svg#glow)" fill="url(http://cdn.test/fx/fx.svg#g)"/></marker>
  <pattern id="dots" width="4" height="4"><circle cx="2" cy="2" r="1"/></pattern>
  <rect id="unused" width="2" height="2"/>
</svg>`;
const MORE = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="glow"><feGaussianBlur stdDeviation="1"/></filter></svg>`;

describe("inlineDocument: SVG url() attributes that name another file", () => {
  const files: Files = {
    "http://cdn.test/fx/fx.svg": { mime: SVG, body: FX },
    "http://cdn.test/fx/more.svg": { mime: SVG, body: MORE },
  };
  const local = (n: number, id: string) => `url(#${SPRITE_ID_PREFIX}${n}-${id})`;

  it("copies the element each one names into the document and points the attribute at the copy", async () => {
    const { doc, out, warnings } = await run(
      `<svg><rect id="f" filter="url(http://cdn.test/fx/fx.svg#soft)" mask="url('//cdn.test/fx/fx.svg#fade')" clip-path="url(&quot;http://cdn.test/fx/fx.svg#half&quot;)"/>` +
        `<path id="m" marker-start="url(http://cdn.test/fx/fx.svg#arrow)" marker-mid="url(http://cdn.test/fx/fx.svg#arrow)" marker-end="url(http://cdn.test/fx/fx.svg#arrow)"/>` +
        `<rect id="p" fill="url(http://cdn.test/fx/fx.svg#dots) #888" stroke="url(http://cdn.test/fx/fx.svg#g)"/>` +
        `<rect id="here" fill="url(#own)" filter="url(data:image/svg+xml,x)"/></svg>`,
      files,
    );
    expect(warnings).toEqual([]);
    expect(out, "no address left that the archive would fetch").not.toContain("cdn.test");
    const f = byId(doc, "f");
    expect([getAttr(f, "filter"), getAttr(f, "mask"), getAttr(f, "clip-path")]).toEqual([local(0, "soft"), local(0, "fade"), local(0, "half")]);
    const m = byId(doc, "m");
    for (const name of ["marker-start", "marker-mid", "marker-end"]) expect(getAttr(m, name), name).toBe(local(0, "arrow"));
    expect(getAttr(byId(doc, "p"), "fill"), "the fallback colour is kept").toBe(`${local(0, "dots")} #888`);
    expect(getAttr(byId(doc, "p"), "stroke")).toBe(local(0, "g"));
    expect(getAttr(byId(doc, "here"), "fill"), "an in-page reference is left alone").toBe("url(#own)");
    expect(getAttr(byId(doc, "here"), "filter"), "a data: URL is left alone").toBe("url(data:image/svg+xml,x)");
    // each copied once, renamed; what a copy refers to comes with it, a reference to a third file too
    for (const id of ["soft", "fade", "half", "arrow", "dots", "g"]) expect(out.split(`id="${SPRITE_ID_PREFIX}0-${id}"`), id).toHaveLength(2);
    expect(out).toContain(`<rect width="10" height="10" fill="${local(0, "g")}">`);
    expect(out).toContain(`filter="${local(1, "glow")}" fill="${local(0, "g")}"`);
    expect(out).toContain(`<filter id="${SPRITE_ID_PREFIX}1-glow">`);
    expect(out).not.toContain("unused");
    expect(out).toContain(`<svg ${SPRITES_ATTRIBUTE}=""`);
  });

  it("points a reference to the page itself at the page's own element, fetching nothing", async () => {
    const { doc, requested } = await run(`<svg><rect id="r" fill="url(http://site.test/blog/post.html#grad) red"/></svg>`, files);
    expect(getAttr(byId(doc, "r"), "fill")).toBe("url(#grad) red");
    expect(requested).toEqual([]);
  });

  it("knows the page by its own URL, not its <base>, as Chromium does", async () => {
    const { doc, requested, warnings } = await run(
      `<svg><rect id="r" fill="url(http://site.test/app/page#grad) red" filter="url(/app/page#soft)"/></svg>`,
      files,
      "http://site.test/",
      "http://site.test/app/page#top",
    );
    expect(getAttr(byId(doc, "r"), "fill")).toBe("url(#grad) red");
    expect(getAttr(byId(doc, "r"), "filter")).toBe("url(#soft)");
    expect(requested).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("sets aside a reference that cannot be had, with a warning, as the failed reference would render", async () => {
    const { doc, out, warnings } = await run(
      `<svg><rect id="gone" fill="url(http://cdn.test/gone.svg#a) #c33" stroke="url(http://cdn.test/gone.svg#b)"/>` +
        `<rect id="html" filter="url(http://cdn.test/page.html#a)"/>` +
        `<rect id="none" clip-path="url(http://cdn.test/fx/fx.svg#zz)" marker-end="url(http://cdn.test/fx/fx.svg)"/></svg>`,
      { ...files, "http://cdn.test/page.html": { mime: "text/html", body: `<svg><filter id="a"></filter></svg>` } },
    );
    const aside = (id: string, name: string) => [getAttr(byId(doc, id), name), getAttr(byId(doc, id), `${UNFETCHED_ATTRIBUTE_PREFIX}${name}`)];
    expect(aside("gone", "fill"), "the fallback colour stays").toEqual(["#c33", "http://cdn.test/gone.svg#a"]);
    expect(aside("gone", "stroke")).toEqual(["none", "http://cdn.test/gone.svg#b"]);
    expect(aside("html", "filter")).toEqual(["none", "http://cdn.test/page.html#a"]);
    expect(aside("none", "clip-path")).toEqual(["none", "http://cdn.test/fx/fx.svg#zz"]);
    expect(aside("none", "marker-end")).toEqual(["none", "http://cdn.test/fx/fx.svg"]);
    expect(out).not.toMatch(/="url\(http/);
    expect(out).not.toContain(SPRITES_ATTRIBUTE);
    expect(warnings.sort()).toEqual(
      [
        'clip-path http://cdn.test/fx/fx.svg#zz: the file has no element with id "zz"; set aside',
        "filter http://cdn.test/page.html#a: text/html is not an SVG file; set aside",
        "marker-end http://cdn.test/fx/fx.svg: names no element of the file; set aside",
      ].sort(),
    );
  });
});

describe("inlineDocument: an SVG cursor attribute", () => {
  it("inlines each url() image as a data: URI, copying nothing in as an element reference", async () => {
    const { doc, out, warnings, requested } = await run(
      `<svg><rect id="c" cursor="url(/cur.png) 4 4, url('http://cdn.test/hand.png'), pointer"/>` +
        `<g id="s" cursor="-webkit-image-set('/cur.png' 1x), auto"/><g id="own" cursor="url(#c), auto"/></svg>`,
      { "http://site.test/cur.png": PNG, "http://cdn.test/hand.png": PNG },
    );
    expect(getAttr(byId(doc, "c"), "cursor")).toBe(`url("${PNG_URI}") 4 4, url("${PNG_URI}"), pointer`);
    expect(getAttr(byId(doc, "s"), "cursor")).toBe(`-webkit-image-set(url("${PNG_URI}") 1x), auto`);
    expect(getAttr(byId(doc, "own"), "cursor"), "an in-page reference is left alone").toBe("url(#c), auto");
    expect(out, "no address left that the archive would fetch").not.toMatch(/\scursor="[^"]*(cdn\.test|cur\.png)/);
    expect(out).not.toContain(SPRITES_ATTRIBUTE);
    expect(out).not.toContain(`${UNFETCHED_ATTRIBUTE_PREFIX}cursor`);
    expect(requested.sort()).toEqual(["http://cdn.test/hand.png", "http://site.test/cur.png", "http://site.test/cur.png"]);
    expect(warnings).toEqual([]);
  });

  it("sets aside an image that cannot be had: the cursor passes to the next, as it did live, and asks nothing of the network", async () => {
    const { doc, out } = await run(
      `<svg><rect id="c" cursor="url(http://cdn.test/gone.png) 2 2, url(/cur.png), url(http://cdn.test/also-gone.png), auto"/></svg>`,
      { "http://site.test/cur.png": PNG },
    );
    const c = byId(doc, "c");
    expect(getAttr(c, "cursor")).toBe(`url("data:,") 2 2, url("${PNG_URI}"), url("data:,"), auto`);
    expect(getAttr(c, `${UNFETCHED_ATTRIBUTE_PREFIX}cursor`)).toBe("http://cdn.test/gone.png http://cdn.test/also-gone.png");
    expect(out, "the cursor itself names no address").not.toMatch(/\scursor="[^"]*http/);
  });
});

describe("inlineDocument: CSS that tries to close its <style>", () => {
  it("cannot end the <style> early, from a linked sheet or an inline one", async () => {
    // postcss escapes `</style` in what it prints; a sheet postcss cannot parse is written back
    // as it came, so that path is the one this guards
    const parsed = `.a{content:"</style><script>alert(1)</script>"}/* </STYLE><img src=x onerror=y()> */`;
    const unparseable = `}</StYlE><script>alert(2)</script><img src=x onerror=y()>`;
    const { out, warnings } = await run(
      `<link rel="stylesheet" href="http://cdn.test/p.css"><link rel="stylesheet" href="http://cdn.test/u.css"><style>${unparseable.replace("</StYlE>", "")}</style>`,
      { "http://cdn.test/p.css": parsed, "http://cdn.test/u.css": unparseable },
    );
    expect(warnings.filter((w) => /did not parse/.test(w))).toHaveLength(2);
    const reparsed = parseDocument(out);
    const tags = allElements(reparsed).map((e) => e.tagName);
    expect(tags).not.toContain("script");
    expect(tags).not.toContain("img");
    expect(tags.filter((t) => t === "style")).toHaveLength(3);
  });
});

describe("absoluteLink", () => {
  it("handles the edge cases", () => {
    expect(absoluteLink("", "http://s.test/")).toBe("");
    expect(absoluteLink("javascript:x()", "http://s.test/")).toBe("javascript:x()");
    expect(absoluteLink("http://[bad", "http://s.test/")).toBe("http://[bad");
  });
});

describe("inlineDocument: a url() or image-set() whose name is written with CSS escapes", () => {
  // Chromium decodes escapes in a function's name, in a <style>, a style attribute and an SVG attribute alike
  it("inlines it in a <style>, a style attribute and an SVG cursor, and copies in what an SVG filter names", async () => {
    const { doc, out, warnings } = await run(
      String.raw`<style>.x{background:\75rl(img/a.png)}</style>` +
        String.raw`<div id="d" style="background: u\72l('/a.png'), image-s\65t('/a.png' 1x)"></div>` +
        String.raw`<svg><rect id="r" filter="u\72l(http://cdn.test/fx/fx.svg#soft)" cursor="\55 RL(/a.png) 2 2, pointer"/></svg>`,
      { "http://site.test/blog/img/a.png": PNG, "http://site.test/a.png": PNG, "http://cdn.test/fx/fx.svg": { mime: SVG, body: FX } },
    );
    expect(warnings).toEqual([]);
    expect(out).toContain(`.x{background:url("${PNG_URI}")}`);
    expect(getAttr(byId(doc, "d"), "style")).toBe(String.raw`background: url("${PNG_URI}"), image-s\65t(url("${PNG_URI}") 1x)`);
    const r = byId(doc, "r");
    expect(getAttr(r, "filter")).toBe(`url(#${SPRITE_ID_PREFIX}0-soft)`);
    expect(getAttr(r, "cursor")).toBe(`url("${PNG_URI}") 2 2, pointer`);
    expect(out, "no address left that the archive would fetch").not.toMatch(/cdn\.test|a\.png/);
  });

  it("renames an escaped url(#id) inside a copied sprite element, and copies what it names", async () => {
    const sprite = String.raw`<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="grad"/><linearGradient id="dots"/>` +
      String.raw`<symbol id="s"><style>.k{fill:\75rl(#dots)}</style><rect fill="u\72l(#grad)"/></symbol></svg>`;
    const { out } = await run(`<svg><use href="http://cdn.test/s.svg#s"/></svg>`, { "http://cdn.test/s.svg": { mime: SVG, body: sprite } });
    expect(out).toContain(`<rect fill="url(#${SPRITE_ID_PREFIX}0-grad)">`);
    expect(out).toContain(`.k{fill:url(#${SPRITE_ID_PREFIX}0-dots)}`);
    for (const id of ["grad", "dots"]) expect(out.split(`id="${SPRITE_ID_PREFIX}0-${id}"`), id).toHaveLength(2);
  });
});

describe("inlineDocument: an SVG <set> or <animate> that writes into a URL attribute", () => {
  const SPRITE = { mime: "image/svg+xml", body: `<svg><symbol id="a"><use href="#c"><set attributeName="href" to="#d"/></use></symbol><symbol id="b"/><symbol id="c"/><symbol id="d"/><filter id="f"/></svg>` };
  /** Every value attribute of every animation that still names the network. */
  const live = (out: string) => out.match(/\s(to|from|by|values)="[^"]*(https?:|\/[\w-]+\.(png|svg))[^"]*"/g) ?? [];

  it("inlines each image an <image> or <feImage> href animation writes, to, from, by and every one of values", async () => {
    const { doc, out, warnings } = await run(
      `<svg><image href="/a.png"><set id="s" attributeName="href" to="/b.png"/>` +
        `<animate id="m" attributeName="xlink:href" values="/c.png; http://cdn.test/d.png;#own;data:,x;" from="/e.png" by="/f.png"/></image>` +
        `<filter><feImage id="fe" href="/a.png"/></filter><set id="t" href="#fe" attributeName="href" to="/b.png"/></svg>`,
      { "http://site.test/a.png": PNG, "http://site.test/b.png": PNG, "http://site.test/c.png": PNG, "http://cdn.test/d.png": PNG, "http://site.test/e.png": PNG },
    );
    expect(getAttr(byId(doc, "s"), "to")).toBe(PNG_URI);
    // in a values list a data: URI has no ";": Chromium splits the list at every one
    const LIST_URI = "data:image/png,%89PNG%0D%0A%1A%0A";
    expect(getAttr(byId(doc, "m"), "values"), "a fragment, a data: URL and the empty last item are kept").toBe(`${LIST_URI};${LIST_URI};#own;data:,x;`);
    expect(getAttr(byId(doc, "m"), "from")).toBe(PNG_URI);
    // f.png cannot be had: set aside, as a value that fails without the network
    expect(getAttr(byId(doc, "m"), "by")).toBe("data:,");
    expect(getAttr(byId(doc, "m"), `${UNFETCHED_ATTRIBUTE_PREFIX}by`)).toBe("http://site.test/f.png");
    expect(getAttr(byId(doc, "t"), "to"), "the <feImage> its href names").toBe(PNG_URI);
    expect(live(out)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("copies in the element a <use> href animation writes, and sets aside one the file does not have", async () => {
    const { doc, out, warnings } = await run(
      `<svg><use href="/icons.svg#a"><set id="s" attributeName="href" to="/icons.svg#b"/><animate id="m" attributeName="href" values="/icons.svg#zz;#own"/></use></svg>`,
      { "http://site.test/icons.svg": SPRITE },
    );
    expect(getAttr(byId(doc, "s"), "to")).toBe(`#${SPRITE_ID_PREFIX}0-b`);
    expect(getAttr(byId(doc, "m"), "values")).toBe("data:,;#own");
    expect(getAttr(byId(doc, "m"), `${UNFETCHED_ATTRIBUTE_PREFIX}values`)).toBe("http://site.test/icons.svg#zz");
    for (const id of ["a", "b", "c", "d"]) expect(out.split(`id="${SPRITE_ID_PREFIX}0-${id}"`).length - 1, id).toBe(1);
    // the copy's own animation writes the copy's ids, not the page's
    expect(out).toContain(`<set attributeName="href" to="#${SPRITE_ID_PREFIX}0-d">`);
    expect(live(out)).toEqual([]);
    expect(warnings).toEqual(['animate href http://site.test/icons.svg#zz: the file has no element with id "zz"; set aside']);
  });

  it("copies in a filter, mask or paint an animation writes, and inlines a cursor's image, setting aside what cannot be had", async () => {
    const { doc, out } = await run(
      `<svg><rect><set id="f" attributeName="filter" to="url(/icons.svg#f)"/>` +
        `<animate id="p" attributeName="fill" values="url(http://cdn.test/gone.svg#p) #c33;url(#own);red" fill="freeze"/>` +
        `<set id="c" attributeName="cursor" to="url(/cur.png) 2 2, url(/gone.png), pointer"/>` +
        `<animate id="cl" attributeName="cursor" values="url(/cur.png), auto;pointer"/></rect></svg>`,
      { "http://site.test/icons.svg": SPRITE, "http://site.test/cur.png": PNG },
    );
    expect(getAttr(byId(doc, "f"), "to")).toBe(`url(#${SPRITE_ID_PREFIX}0-f)`);
    expect(getAttr(byId(doc, "p"), "values"), "the paint falls back to its colour, as it did live").toBe("#c33;url(#own);red");
    expect(getAttr(byId(doc, "p"), `${UNFETCHED_ATTRIBUTE_PREFIX}values`)).toBe("http://cdn.test/gone.svg#p");
    expect(getAttr(byId(doc, "p"), "fill"), "an animation's own fill is its timing").toBe("freeze");
    expect(getAttr(byId(doc, "c"), "to")).toBe(`url("${PNG_URI}") 2 2, url("data:,"), pointer`);
    expect(getAttr(byId(doc, "c"), `${UNFETCHED_ATTRIBUTE_PREFIX}to`)).toBe("http://site.test/gone.png");
    expect(getAttr(byId(doc, "cl"), "values")).toBe(`url("data:image/png,%89PNG%0D%0A%1A%0A"), auto;pointer`);
    expect(live(out)).toEqual([]);
  });

  it("makes an <a> href animation's link absolute and sets aside one whose target is not an image, a <use> or a link", async () => {
    const { doc, warnings, requested } = await run(
      `<svg><a><set id="a" attributeName="href" to="next.html"/></a>` +
        `<linearGradient id="g"><set id="g2" attributeName="href" to="/other.svg#g"/></linearGradient>` +
        `<set id="n" href="#nobody" attributeName="href" to="/x.png"/></svg>`,
      {},
    );
    expect(getAttr(byId(doc, "a"), "to")).toBe("http://site.test/blog/next.html");
    expect(getAttr(byId(doc, "g2"), "to")).toBe("data:,");
    expect(getAttr(byId(doc, "n"), "to")).toBe("data:,");
    expect(getAttr(byId(doc, "n"), `${UNFETCHED_ATTRIBUTE_PREFIX}to`)).toBe("http://site.test/x.png");
    expect(requested).toEqual([]);
    expect(warnings.sort()).toEqual(
      ["set href http://site.test/other.svg#g: a <linearGradient> href is not archived; set aside", "set href http://site.test/x.png: animates no element of the page; set aside"].sort(),
    );
  });

  it("leaves an animation of any other attribute, and an HTML <set>, alone", async () => {
    const { doc, requested } = await run(
      `<svg><rect><set id="w" attributeName="width" to="/x.png"/><animate id="h" attributeName="height" values="/x.png;/y.png"/></rect></svg><set id="html" attributename="href" to="/x.png"></set>`,
      {},
    );
    expect(getAttr(byId(doc, "w"), "to")).toBe("/x.png");
    expect(getAttr(byId(doc, "h"), "values")).toBe("/x.png;/y.png");
    expect(getAttr(byId(doc, "html"), "to")).toBe("/x.png");
    expect(requested).toEqual([]);
  });
});
