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

async function run(html: string, files: Files, baseUrl?: string) {
  const doc = parseDocument(html);
  const { ctx, warnings, requested } = ctxFor(files, baseUrl);
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

  it("sets aside what is not an image, with a warning, and never puts a data: document into the element", async () => {
    const { doc, out, warnings, requested } = await run(
      `<object id="doc" data="/pages/inner.html"><p>fallback</p></object>` +
        `<embed id="pdf" src="/files/report.pdf" type="application/pdf">` +
        `<object id="gone" data="/img/gone.png" type="image/png">fallback</object>`,
      { "http://site.test/pages/inner.html": { mime: "text/html; charset=utf-8", body: "<p>inner</p>" } },
    );
    expect(getAttr(byId(doc, "doc"), "data")).toBeNull();
    expect(getAttr(byId(doc, "doc"), `${UNFETCHED_ATTRIBUTE_PREFIX}data`)).toBe("http://site.test/pages/inner.html");
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
      "object http://site.test/pages/inner.html: text/html is not an image; set aside",
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
