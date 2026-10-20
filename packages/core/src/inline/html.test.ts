import { describe, expect, it } from "vitest";
import { allElements, getAttr, parseDocument, serializeDocument } from "../dom.ts";
import type { Resource } from "../resources.ts";
import { absoluteLink, inlineDocument, type HtmlContext } from "./html.ts";

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

  it("keeps a stylesheet it cannot fetch as a link with an absolute href", async () => {
    const { out } = await run(`<link rel="stylesheet" href="/gone.css">`, {});
    expect(out).toContain(`<link rel="stylesheet" href="http://site.test/gone.css">`);
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

  it("keeps an image it cannot fetch with an absolute src", async () => {
    const { doc } = await run(`<img id="i" src="gone.png">`, {});
    expect(getAttr(byId(doc, "i"), "src")).toBe("http://site.test/blog/gone.png");
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

describe("absoluteLink", () => {
  it("handles the edge cases", () => {
    expect(absoluteLink("", "http://s.test/")).toBe("");
    expect(absoluteLink("javascript:x()", "http://s.test/")).toBe("javascript:x()");
    expect(absoluteLink("http://[bad", "http://s.test/")).toBe("http://[bad");
  });
});
