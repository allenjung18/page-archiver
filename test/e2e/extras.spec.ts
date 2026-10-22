// `pa save <url> -d <dir>` end to end: the folder holds the archive, the reader copy, the MHTML
// copy, a full-page PNG and PDF, and a meta.json that validates against META_SCHEMA. The reader
// copy and the MHTML copy each open with the network gone.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { expect, test, type Browser } from "@playwright/test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PNG } from "pngjs";
import { META_SCHEMA, parseMhtml, readStamp, verifyStamp, type PageMeta } from "@page-archiver/core";
import { ASSETS_ORIGIN, fixtureUrl, VIEWPORT } from "./env.ts";
import { printPdf, screenshotPng } from "../../packages/core/src/extras/shot.ts";
import { openOffline } from "./offline.ts";

const run = promisify(execFile);
const PA = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const validateMeta = new Ajv2020({ strict: true, allErrors: true }).compile(META_SCHEMA);
const ALL_FILES = ["archive.html", "archive.mhtml", "meta.json", "reader.html", "shot.pdf", "shot.png"];

interface Article {
  title: string;
  byline: string;
  site: string;
  lang: string;
  canonicalUrl: string | null;
  /** A sentence of the article's body. */
  sentence: string;
  /** Page furniture that is not the article. */
  junk: string[];
}

const ARTICLES: Record<string, Article> = {
  "plain-article": {
    title: "The Lighthouse Keeper's Ledger",
    byline: "By A. Fixture · 12 March 2026",
    site: "127.0.0.1",
    lang: "en",
    canonicalUrl: null,
    sentence: "No ships. Fog. I rang the bell all night.",
    junk: [],
  },
  "news-article": {
    title: "Tides of the Inner Basin",
    byline: "Mara Quill",
    site: "The Harbour Gazette",
    lang: "en-GB",
    canonicalUrl: "https://gazette.example/2026/03/tides-of-the-inner-basin",
    sentence: "the public gallery is open.",
    junk: ["Subscribe now", "Related stories", "A record crab season", "Privacy"],
  },
};

/** Opens an MHTML file in Chromium with the network cut off; what it shows and what it asked for. */
async function openMhtml(browser: Browser, file: string) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.setOffline(true);
  const blocked: string[] = [];
  try {
    await context.route("**/*", async (route) => {
      if (route.request().url().startsWith("file:")) return route.continue();
      blocked.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    return {
      blocked,
      title: await page.title(),
      h1: (await page.locator("h1").first().textContent())?.trim(),
      images: await page.evaluate(() => [...document.images].map((i) => i.naturalWidth)),
      scripts: await page.locator("script").count(),
    };
  } finally {
    await context.close();
  }
}

for (const [name, expected] of Object.entries(ARTICLES)) {
  test(`pa save -d writes all the outputs for ${name}`, async ({ browser }) => {
    const dir = test.info().outputPath("capture");
    const url = fixtureUrl(name);
    const { stdout, stderr } = await run(process.execPath, [PA, "save", url, "-d", dir, "--tag", "fixture", "--tag", name]);
    expect(stderr).toBe("");
    expect(stdout.split("\n")[0]).toBe(`saved ${dir}`);
    for (const f of ALL_FILES) expect(stdout).toMatch(new RegExp(`^  ${f.replace(".", "\\.")} \\(\\d+(\\.\\d+)? (KB|MB)\\)$`, "m"));
    expect(readdirSync(dir).sort()).toEqual(ALL_FILES);
    const file = (f: string) => join(dir, f);
    const archive = readFileSync(file("archive.html"), "utf8");
    const stampMetas = readStamp(archive);

    await test.step("meta.json validates against the schema and describes the capture", () => {
      const meta = JSON.parse(readFileSync(file("meta.json"), "utf8")) as PageMeta;
      expect(validateMeta(meta), JSON.stringify(validateMeta.errors)).toBe(true);
      expect(meta).toMatchObject({
        url,
        canonicalUrl: expected.canonicalUrl,
        title: expected.title,
        byline: expected.byline,
        site: expected.site,
        lang: expected.lang,
        tags: ["fixture", name],
        warnings: [],
        sha256: stampMetas["sha256"],
        capturedAt: stampMetas["captured-at"],
        tool: { name: "page-archiver", version: stampMetas["tool-version"] },
      });
      expect(meta.excerpt).toBeTruthy();
      expect(verifyStamp(archive)).toBe(true);
      expect(meta.bytes).toEqual({
        archive: statSync(file("archive.html")).size,
        reader: statSync(file("reader.html")).size,
        mhtml: statSync(file("archive.mhtml")).size,
        png: statSync(file("shot.png")).size,
        pdf: statSync(file("shot.pdf")).size,
      });
    });

    await test.step("the reader copy reads cleanly, offline, under the archive CSP", async () => {
      const reader = readFileSync(file("reader.html"), "utf8");
      expect(reader).not.toMatch(/<script|<link|\son[a-z]+=|javascript:/i);
      // its images are the archive's data: URIs, not links back to the site
      expect(reader).not.toContain(ASSETS_ORIGIN);
      expect(reader).toContain(`<meta name="page-archiver:source-url" content="${url}">`);
      let seen: { h1: string; byline: string | null; text: string; images: number[] } | undefined;
      const open = await openOffline(browser, file("reader.html"), {
        inspect: async (page) => {
          seen = await page.evaluate(() => ({
            h1: document.querySelector("h1")?.textContent ?? "",
            byline: document.querySelector(".pa-byline")?.textContent ?? null,
            text: document.querySelector(".pa-content")?.textContent ?? "",
            images: [...document.images].map((i) => i.naturalWidth),
          }));
        },
      });
      expect(open.blocked).toEqual([]);
      expect(open.violations).toEqual([]);
      expect(seen!.h1).toBe(expected.title);
      expect(seen!.byline).toBe(expected.byline);
      expect(seen!.text).toContain(expected.sentence);
      for (const junk of expected.junk) expect(seen!.text).not.toContain(junk);
      expect(seen!.images.length).toBeGreaterThan(0);
      for (const w of seen!.images) expect(w).toBeGreaterThan(0);
      // the article's own heading is not repeated under the reader header
      expect(seen!.text).not.toContain(expected.title);
    });

    await test.step("the MHTML file is well formed and opens in Chromium offline", async () => {
      const mhtml = parseMhtml(readFileSync(file("archive.mhtml"), "utf8"));
      const [main, ...rest] = mhtml.parts;
      expect(main).toMatchObject({ type: "text/html", location: url });
      expect(main!.body.toString("utf8")).toContain(expected.sentence.replace(/\.$/, ""));
      for (const img of ["hero.png", "figure.png"]) {
        const part = rest.find((p) => p.location === `${ASSETS_ORIGIN}/img/${img}`);
        expect(part?.type, img).toBe("image/png");
        expect(part!.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), img).toBe(true);
      }
      expect(rest.some((p) => p.type === "text/css" && p.location === `${ASSETS_ORIGIN}/css/article.css`)).toBe(true);
      const opened = await openMhtml(browser, file("archive.mhtml"));
      expect(opened.blocked).toEqual([]);
      expect(opened.h1).toBe(expected.title);
      expect(opened.title).toContain(expected.title);
      expect(opened.images).toHaveLength(2);
      for (const w of opened.images) expect(w).toBeGreaterThan(0);
      expect(opened.scripts).toBe(0);
    });

    await test.step("the PNG is the full page and the PDF is a PDF", async () => {
      const png = PNG.sync.read(readFileSync(file("shot.png")));
      expect(png.width).toBe(VIEWPORT.width);
      // the whole page, not the first screen: as tall as the page itself, measured on a live load
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const live = await context.newPage();
      await live.goto(url, { waitUntil: "load" });
      const pageHeight = await live.evaluate(() => document.documentElement.scrollHeight);
      await context.close();
      expect(pageHeight, "the fixture is taller than one screen, so the check can tell").toBeGreaterThan(VIEWPORT.height);
      expect(png.height, "full-page PNG as tall as the page").toBe(pageHeight);
      const pdf = readFileSync(file("shot.pdf"));
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");
      expect(pdf.toString("latin1")).toMatch(/\/Type\s*\/Page[^s]/);
    });
  });
}

test("the PDF keeps the page's own backgrounds, and the PNG is taller than the first screen for a tall page", async ({ browser }) => {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent('<body style="margin:0"><div style="background:#c00;height:2400px"></div></body>');
    const png = PNG.sync.read(await screenshotPng(page));
    expect(png.height).toBe(2400);
    const withBackground = await printPdf(page);
    const without = await page.pdf({ printBackground: false, preferCSSPageSize: true, format: "A4" });
    const drawn = (pdf: Buffer) =>
      [...pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1")).join("\n");
    expect(drawn(withBackground), "the red block is painted").toContain(".8 0 0 rg");
    expect(drawn(without), "and is not, without printBackground").not.toContain(".8 0 0 rg");
  } finally {
    await context.close();
  }
});

test("pa save -d with extras turned off writes only what is left, even over an earlier capture", async () => {
  const dir = test.info().outputPath("capture");
  await run(process.execPath, [PA, "save", fixtureUrl("news-article"), "-d", dir]);
  expect(readdirSync(dir).sort()).toEqual(ALL_FILES);
  const { stderr } = await run(process.execPath, [PA, "save", fixtureUrl("plain-article"), "-d", dir, "--no-mhtml", "--no-shot"]);
  expect(stderr).toBe("");
  expect(readdirSync(dir).sort()).toEqual(["archive.html", "meta.json", "reader.html"]);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as PageMeta;
  expect(validateMeta(meta), JSON.stringify(validateMeta.errors)).toBe(true);
  expect(Object.keys(meta.bytes).sort()).toEqual(["archive", "reader"]);
  expect(meta.tags).toEqual([]);
  expect(meta.url).toBe(fixtureUrl("plain-article"));
  expect(meta.sha256).toBe(readStamp(readFileSync(join(dir, "archive.html"), "utf8"))["sha256"]);
});
