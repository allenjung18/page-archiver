// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { snapshot } from "./snapshot.ts";

function setCurrentSrc(img: Element, url: string): void {
  Object.defineProperty(img, "currentSrc", { value: url, configurable: true });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("snapshot: images", () => {
  it("writes currentSrc into src and removes srcset, sizes and loading", () => {
    document.body.innerHTML = `<img src="/small.png" srcset="/small.png 1x, /big.png 2x" sizes="100vw" loading="lazy" alt="a">`;
    const img = document.querySelector("img")!;
    setCurrentSrc(img, "http://site.test/big.png");
    const snap = snapshot();
    const out = new DOMParser().parseFromString(snap.html, "text/html").querySelector("img")!;
    expect(out.getAttribute("src")).toBe("http://site.test/big.png");
    for (const name of ["srcset", "sizes", "loading"]) expect(out.hasAttribute(name), name).toBe(false);
    expect(out.getAttribute("alt")).toBe("a");
    expect(snap.manifest).toContain("http://site.test/big.png");
    // the live page is untouched
    expect(img.getAttribute("srcset")).toBe("/small.png 1x, /big.png 2x");
  });

  it("falls back to a data-src pattern when the image never got a URL", () => {
    document.body.innerHTML = `<img data-src="/later.png" alt="b">`;
    setCurrentSrc(document.querySelector("img")!, "");
    const snap = snapshot();
    const out = new DOMParser().parseFromString(snap.html, "text/html").querySelector("img")!;
    expect(out.getAttribute("src")).toMatch(/\/later\.png$/);
    expect(new URL(out.getAttribute("src")!).pathname).toBe("/later.png");
  });

  it("collapses <picture> to its <img>", () => {
    document.body.innerHTML = `<p><picture><source srcset="/a.webp" type="image/webp"><img src="/a.png" alt="c"></picture></p>`;
    setCurrentSrc(document.querySelector("img")!, "http://site.test/a.webp");
    const snap = snapshot();
    const doc = new DOMParser().parseFromString(snap.html, "text/html");
    expect(doc.querySelector("picture")).toBeNull();
    expect(doc.querySelector("source")).toBeNull();
    expect(doc.querySelector("p > img")?.getAttribute("src")).toBe("http://site.test/a.webp");
  });

  it("lists stylesheet hrefs as absolute URLs in the manifest", () => {
    document.head.innerHTML = `<link rel="stylesheet" href="/css/site.css">`;
    const snap = snapshot();
    const href = new DOMParser().parseFromString(snap.html, "text/html").querySelector("link")!.getAttribute("href")!;
    expect(new URL(href).pathname).toBe("/css/site.css");
    expect(snap.manifest).toContain(href);
  });

  it("keeps data: URLs out of the manifest", () => {
    document.body.innerHTML = `<img src="data:image/png;base64,AAAA" alt="">`;
    setCurrentSrc(document.querySelector("img")!, "data:image/png;base64,AAAA");
    expect(snapshot().manifest).toEqual([]);
  });
});
