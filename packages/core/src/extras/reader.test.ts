import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractReader, renderReader, type ReaderView } from "./reader.ts";

const ASSETS = "http://assets.test";

function fixture(name: string): { html: string; url: string } {
  const html = readFileSync(new URL(`../../../../fixtures/pages/${name}.html`, import.meta.url), "utf8").replaceAll("{{ASSETS}}", ASSETS);
  return { html, url: `http://pages.test/${name}.html` };
}

describe("extractReader", () => {
  it("finds the plain article's title and byline", () => {
    const { html, url } = fixture("plain-article");
    const view = extractReader(html, url)!;
    expect(view.title).toBe("The Lighthouse Keeper's Ledger");
    expect(view.byline).toBe("By A. Fixture · 12 March 2026");
    expect(view.lang).toBe("en");
    expect(view.siteName).toBeNull();
    expect(view.excerpt).toMatch(/^For forty years the keeper wrote one line a night/);
    expect(view.textContent).toContain("I rang the bell all night.");
    expect(view.content).toContain(`src="${ASSETS}/img/figure.png"`);
    // links resolve against the page
    expect(view.content).toContain(`href="http://pages.test/other.html"`);
  });

  it("finds the news article's title (site name cut off), byline, site and lang from its metadata", () => {
    const { html, url } = fixture("news-article");
    const view = extractReader(html, url)!;
    expect(view.title).toBe("Tides of the Inner Basin");
    expect(view.byline).toBe("Mara Quill");
    expect(view.siteName).toBe("The Harbour Gazette");
    expect(view.lang).toBe("en-GB");
    expect(view.excerpt).toBe("Why the inner basin floods twice a year, and what the harbour board plans to do about it.");
    expect(view.textContent).toContain("the public gallery is open");
    // the masthead, the related stories and the footer are not the article
    for (const junk of ["Subscribe now", "Related stories", "A record crab season", "Privacy"]) expect(view.textContent).not.toContain(junk);
  });

  it("keeps inlined images as they are", () => {
    const img = "data:image/png;base64," + Buffer.alloc(300, 7).toString("base64");
    const { html, url } = fixture("plain-article");
    const view = extractReader(html.replace(`${ASSETS}/img/figure.png`, img), url)!;
    expect(view.content).toContain(`src="${img}"`);
  });

  it("never lets a lazy-image attribute replace an inlined image, and keeps a small one", () => {
    const big = "data:image/jpeg;base64," + Buffer.alloc(300, 7).toString("base64");
    const tiny = "data:image/png;base64," + Buffer.alloc(20, 1).toString("base64");
    const { html, url } = fixture("plain-article");
    const page = html
      .replace(`<img src="${ASSETS}/img/hero.png"`, `<img class="hero lazyloaded" data-src="https://cdn.test/hero.jpg" data-srcset="https://cdn.test/hero.jpg 1x" src="${big}"`)
      .replace(`<img src="${ASSETS}/img/figure.png"`, `<img alt="ledger.png" src="${tiny}"`)
      .replace("<blockquote>", `<p><img class="lazy" data-src="https://cdn.test/never-loaded.png" alt="">A lazy image that never loaded.</p><blockquote>`);
    const view = extractReader(page, url)!;
    expect(view.content).toContain(`src="${big}"`);
    expect(view.content).toContain(`src="${tiny}"`);
    expect(view.content).not.toContain("cdn.test");
    expect(view.content).not.toContain("page-archiver-image:");
  });

  it("reads an article that lives in a shadow root", () => {
    const body = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} of a story told inside a web component, long enough that a reader view should keep it as the article body.</p>`).join("");
    const html = `<!doctype html><html lang="en"><head><title>Shadow story</title></head><body><nav><a href="/">Home</a></nav><story-card><template shadowrootmode="open"><style>p{color:red}</style><article><h1>Shadow story</h1>${body}</article></template></story-card></body></html>`;
    const view = extractReader(html, "http://pages.test/shadow.html")!;
    expect(view.title).toBe("Shadow story");
    expect(view.textContent).toContain("Paragraph 5 of a story told inside a web component");
    expect(view.content).not.toContain("color:red");
  });

  it("returns null when there is no article", () => {
    expect(extractReader("<!doctype html><title>t</title><body></body>", "http://pages.test/")).toBeNull();
  });
});

describe("renderReader", () => {
  const view: ReaderView = {
    title: `Fish & <Chips>`,
    byline: "By \"Someone\"",
    siteName: "Site",
    excerpt: null,
    lang: "en-GB",
    dir: "ltr",
    publishedTime: null,
    content: `<div><p onclick="alert(1)">Body <a href="javascript:alert(1)">x</a></p><script>alert(2)</script><img src="data:image/png;base64,AAAA"></div>`,
    textContent: "Body x",
  };
  const page = renderReader(view, { url: "https://example.com/a?b=1&c=2", capturedAt: new Date("2026-03-12T10:00:00Z") });

  it("writes a complete page with the header, escaped", () => {
    expect(page).toMatch(/^<!DOCTYPE html><html lang="en-GB" dir="ltr"><head>\s*<meta charset="utf-8">/);
    expect(page).toContain("<title>Fish &amp; &lt;Chips&gt;</title>");
    expect(page).toContain("<h1>Fish &amp; &lt;Chips&gt;</h1>");
    expect(page).toContain(`<p class="pa-byline">By "Someone"</p>`);
    expect(page).toContain(`<p class="pa-site">Site</p>`);
    expect(page).toContain(`<meta name="page-archiver:source-url" content="https://example.com/a?b=1&amp;c=2">`);
    expect(page).toContain(`<time datetime="2026-03-12T10:00:00.000Z">2026-03-12</time>`);
    expect(page).toContain(`<img src="data:image/png;base64,AAAA">`);
  });

  it("carries no script, handler or javascript: URL", () => {
    expect(page).not.toMatch(/<script|onclick|javascript:/i);
  });

  it("leaves out the site and byline lines when there are none", () => {
    const bare = renderReader({ ...view, siteName: null, byline: null, lang: null, dir: null }, { url: "https://example.com/", capturedAt: new Date(0) });
    expect(bare).not.toMatch(/class="pa-site"|class="pa-byline"|<html [^>]*(lang|dir)=/);
  });
});
