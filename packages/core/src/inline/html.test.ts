import { describe, expect, it } from "vitest";
import { allElements, getAttr, parseDocument, serializeDocument } from "../dom.ts";
import type { Resource } from "../resources.ts";
import { absoluteLink, inlineDocument, MEDIA_SRC_ATTRIBUTE, POSTER_FRAME_ATTRIBUTE, UNFETCHED_ATTRIBUTE_PREFIX, VIDEO_RATIO_ATTRIBUTE, type HtmlContext } from "./html.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

function ctxFor(files: Record<string, string | Buffer>, baseUrl = "http://site.test/blog/post.html") {
  const warnings: string[] = [];
  const ctx: HtmlContext = {
    baseUrl,
    async get(url): Promise<Resource | null> {
      const f = files[url];
      if (f === undefined) return null;
      return typeof f === "string" ? { url, mime: "text/css", bytes: Buffer.from(f) } : { url, mime: "image/png", bytes: f };
    },
    warn: (m) => warnings.push(m),
  };
  return { ctx, warnings };
}

async function run(html: string, files: Record<string, string | Buffer>, baseUrl?: string) {
  const doc = parseDocument(html);
  const { ctx, warnings } = ctxFor(files, baseUrl);
  await inlineDocument(doc, ctx);
  return { doc, out: serializeDocument(doc), warnings };
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
