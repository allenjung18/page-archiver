import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePages, startFixtureServer, type FixtureServer } from "./server.ts";

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ pagesPort: 0, assetsPort: 0 });
});

afterAll(async () => {
  await server.close();
});

function assetUrls(html: string, origin: string): string[] {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...html.matchAll(new RegExp(`${escaped}/[^"')\\s]+`, "g"))].map((m) => m[0]);
}

describe("fixture server", () => {
  it("lists both chunk-0 pages", () => {
    expect(fixturePages()).toEqual(expect.arrayContaining(["lazy-images", "plain-article"]));
  });

  it("serves pages and assets on two different origins", () => {
    expect(new URL(server.pagesOrigin).port).not.toBe(new URL(server.assetsOrigin).port);
  });

  it("answers the health check", async () => {
    const res = await fetch(`${server.pagesOrigin}/healthz`);
    expect(res.status).toBe(200);
  });

  for (const name of ["plain-article", "lazy-images"]) {
    it(`serves ${name} with every asset pointing at the assets origin, and every asset resolves`, async () => {
      const res = await fetch(server.pageUrl(name));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      const html = await res.text();
      expect(html).not.toContain("{{ASSETS}}");
      const urls = assetUrls(html, server.assetsOrigin);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        const asset = await fetch(url);
        expect(asset.status, url).toBe(200);
        expect(asset.headers.get("access-control-allow-origin"), url).toBe("*");
        expect((await asset.arrayBuffer()).byteLength, url).toBeGreaterThan(0);
      }
    });
  }

  it("resolves a stylesheet's url() against the sheet, on the assets origin", async () => {
    const css = await (await fetch(`${server.assetsOrigin}/css/article.css`)).text();
    const rel = /url\(([^)]+)\)/.exec(css)?.[1];
    expect(rel).toBe("../img/paper.png");
    const res = await fetch(new URL(rel ?? "", `${server.assetsOrigin}/css/article.css`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("does not serve pages from the assets port or assets from the pages port", async () => {
    expect((await fetch(`${server.assetsOrigin}/plain-article.html`)).status).toBe(404);
    expect((await fetch(`${server.pagesOrigin}/img/hero.png`)).status).toBe(404);
  });

  it("refuses paths that escape the fixture folders", async () => {
    for (const path of ["/..%2fserver.ts", "/%2e%2e/server.ts", "/../../package.json"]) {
      expect((await fetch(`${server.assetsOrigin}${path}`)).status, path).toBe(404);
      expect((await fetch(`${server.pagesOrigin}${path}`)).status, path).toBe(404);
    }
  });
});
