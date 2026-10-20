// The reader UI end to end: `pa serve` (the built CLI) over a library of the six SingleFile
// saves in fixtures/import, each test with its own library in its own output folder and its
// own server on a free port. Search with highlighted snippets and filters, open a page and
// toggle Original / Reader, tags, delete, re-capture; the archive route's CSP header byte for
// byte; and an archive with a planted script that must not run. `pa serve` is always started
// with --no-open and PA_NO_OPEN=1, so no test opens a browser of its own.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import type { PageRecord } from "@page-archiver/library";
import { fixtureUrl } from "./env.ts";

const execFileP = promisify(execFile);
const PA = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/import/", import.meta.url));

/** Written out in full: the header must be exactly these bytes. */
const EXACT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; frame-src data: about:";

const SOURDOUGH = "Keeping a Sourdough Starter Alive";

interface Served {
  lib: string;
  url: string;
  token: string;
  pages: PageRecord[];
  stop(): Promise<void>;
}

const env = (lib: string) => ({ ...process.env, PA_LIBRARY: lib, PA_NO_OPEN: "1" });

async function pa(lib: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP(process.execPath, [PA, ...args, "--library", lib], { env: env(lib), maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The six import fixtures in a fresh library (the sourdough page tagged), plus `extra` saved from the fixture server. */
async function library(lib: string, extra: string[] = []): Promise<PageRecord[]> {
  const files = readdirSync(IMPORT_DIR).filter((f) => f.endsWith(".html")).sort();
  await pa(lib, "import", ...files.filter((f) => f !== "sourdough-starter.html").map((f) => join(IMPORT_DIR, f)));
  await pa(lib, "import", join(IMPORT_DIR, "sourdough-starter.html"), "--tag", "baking");
  for (const name of extra) await pa(lib, "save", fixtureUrl(name), "--no-mhtml", "--no-shot");
  return JSON.parse(await pa(lib, "list", "--json")) as PageRecord[];
}

/** `pa serve --port 0 --no-open` on lib; resolves once it prints its address and token. */
async function serve(lib: string, pages: PageRecord[]): Promise<Served> {
  const child: ChildProcess = spawn(process.execPath, [PA, "serve", "--library", lib, "--port", "0", "--no-open"], { env: env(lib), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const started = await new Promise<{ url: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pa serve did not start:\n${out}\n${err}`)), 15_000);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const url = / at (http:\/\/127\.0\.0\.1:\d+\/)\n/.exec(out)?.[1];
      const token = /^write token: ([0-9a-f]{48})$/m.exec(out)?.[1];
      if (url && token) {
        clearTimeout(timer);
        resolve({ url, token });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pa serve exited (${code}):\n${out}\n${err}`));
    });
  });
  expect(out).toContain(`serving ${lib} (${pages.length} pages)`);
  return {
    lib,
    ...started,
    pages,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

let server: Served | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(extra: string[] = []): Promise<Served> {
  const lib = test.info().outputPath("library");
  server = await serve(lib, await library(lib, extra));
  return server;
}

const results = (page: Page) => page.getByTestId("result");
const viewer = (page: Page) => page.locator("main iframe");

async function openApp(page: Page, s: Served): Promise<void> {
  await page.goto(s.url);
  await expect(results(page)).toHaveCount(s.pages.length);
}

test("the archive route serves both copies under exactly the archive CSP", async ({ request }) => {
  const s = await start();
  const p = s.pages.find((x) => x.title === SOURDOUGH)!;
  for (const view of ["original", "reader"]) {
    const res = await request.get(`${s.url}archive/${p.id}/${view}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-security-policy"]).toBe(EXACT_CSP);
    expect(res.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(readFileSync(join(s.lib, p.dir, view === "original" ? "archive.html" : "reader.html"), "utf8"));
  }
  // writes need the token the server printed
  expect((await request.delete(`${s.url}api/pages/${p.id}`)).status()).toBe(401);
  expect((await request.delete(`${s.url}api/pages/${p.id}`, { headers: { Authorization: "Bearer 00" } })).status()).toBe(401);
  expect(existsSync(join(s.lib, p.dir))).toBe(true);
});

test("search shows highlighted snippets, and site, tag and date filters narrow the list", async ({ page }) => {
  const s = await start();
  await openApp(page, s);

  await page.getByRole("searchbox", { name: "Search" }).fill("wobbleloaf");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first().locator(".title")).toHaveText(SOURDOUGH);
  await expect(results(page).first().getByTestId("snippet").locator("mark")).toHaveText(["wobbleloaf"]);

  await page.getByRole("searchbox", { name: "Search" }).fill("nowhereword");
  await expect(page.getByTestId("no-results")).toHaveText("Nothing matches.");
  await page.getByRole("searchbox", { name: "Search" }).fill("");
  await expect(results(page)).toHaveCount(6);

  await page.getByRole("combobox", { name: "Site", exact: true }).selectOption("Green Margins");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first().locator(".title")).toHaveText("Starting a Moss Garden in a Shady Corner");
  await page.getByRole("combobox", { name: "Site", exact: true }).selectOption("");

  await page.getByRole("combobox", { name: "Tag", exact: true }).selectOption("baking");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first().locator(".title")).toHaveText(SOURDOUGH);
  await page.getByRole("combobox", { name: "Tag", exact: true }).selectOption("");

  // saved 2026-02-07 … 2026-09-28: from June on leaves the June, August and September saves
  await page.getByLabel("From", { exact: true }).fill("2026-06-01");
  await expect(results(page)).toHaveCount(3);
  await page.getByLabel("To", { exact: true }).fill("2026-06-30");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first().locator(".title")).toHaveText(/^Review: The Lantern Coast/);
});

test("opening a page shows it in a script-less sandbox, and the toggle switches to the reader copy", async ({ page }) => {
  const s = await start();
  const p = s.pages.find((x) => x.title === SOURDOUGH)!;
  await openApp(page, s);
  await results(page).filter({ hasText: SOURDOUGH }).click();

  await expect(page.getByRole("heading", { level: 2 })).toHaveText(SOURDOUGH);
  const frame = viewer(page);
  await expect(frame).toHaveAttribute("src", `/archive/${p.id}/original`);
  // sandboxed with no permissions at all: in particular, no allow-scripts
  await expect(frame).toHaveAttribute("sandbox", "");
  const original = page.frameLocator("main iframe");
  await expect(original.getByText("wobbleloaf", { exact: false })).toBeVisible();
  await expect(original.locator("article.pa-reader")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Reader" }).click();
  await expect(page.getByRole("button", { name: "Reader" })).toHaveAttribute("aria-pressed", "true");
  await expect(viewer(page)).toHaveAttribute("src", `/archive/${p.id}/reader`);
  await expect(viewer(page)).toHaveAttribute("sandbox", "");
  const reader = page.frameLocator("main iframe");
  await expect(reader.locator("article.pa-reader")).toHaveCount(1);
  await expect(reader.getByText("wobbleloaf", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Original" }).click();
  await expect(viewer(page)).toHaveAttribute("src", `/archive/${p.id}/original`);
});

test("tags are added and removed from the page and filter the list", async ({ page }) => {
  const s = await start();
  await openApp(page, s);
  await results(page).filter({ hasText: "Notes from a Night Train" }).click();
  await page.getByLabel("New tag").fill("trains");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".tag-editor .tag")).toHaveText(["trains×"]);
  await page.getByRole("combobox", { name: "Tag", exact: true }).selectOption("trains");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first().locator(".title")).toHaveText("Notes from a Night Train");
  const meta = JSON.parse(readFileSync(join(s.lib, s.pages.find((x) => x.title === "Notes from a Night Train")!.dir, "meta.json"), "utf8")) as { tags: string[] };
  expect(meta.tags).toEqual(["trains"]);
  await page.getByRole("button", { name: "Remove tag trains" }).click();
  await expect(page.locator(".tag-editor .tag")).toHaveCount(0);
});

test("delete removes the page from the list, the index and the disk", async ({ page, request }) => {
  const s = await start();
  const p = s.pages.find((x) => x.title === SOURDOUGH)!;
  await openApp(page, s);
  await results(page).filter({ hasText: SOURDOUGH }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  // nothing is deleted until it is confirmed
  await expect(page.getByText("Delete this capture?")).toBeVisible();
  expect(existsSync(join(s.lib, p.dir))).toBe(true);
  await page.getByRole("button", { name: "Yes, delete" }).click();

  await expect(results(page)).toHaveCount(5);
  await expect(results(page).filter({ hasText: SOURDOUGH })).toHaveCount(0);
  await expect(page.locator("main")).toHaveText("Choose a page to read it.");
  expect(existsSync(join(s.lib, p.dir))).toBe(false);
  expect((await request.get(`${s.url}api/pages/${p.id}`)).status()).toBe(404);
  expect((await request.get(`${s.url}archive/${p.id}/original`)).status()).toBe(404);
  await page.getByRole("searchbox", { name: "Search" }).fill("wobbleloaf");
  await expect(page.getByTestId("no-results")).toBeVisible();
  // and it stays deleted when the index is rebuilt from the folders
  expect(await pa(s.lib, "reindex")).toBe(`indexed 5 pages in ${s.lib}\n`);
});

test("a script planted in an archive does not run, in the viewer or opened directly", async ({ page }) => {
  const s = await start();
  const p = s.pages.find((x) => x.title === SOURDOUGH)!;
  // the capture pipeline strips scripts; this one is written in afterwards, as a page that slipped
  // through would carry it, into both copies
  const plant = `<script>console.log("PLANTED-SCRIPT-RAN");document.body.insertAdjacentHTML("beforeend","<p id=planted-marker>ran</p>")</script>` + `<img id="planted-img" src="data:," onerror="console.log('PLANTED-HANDLER-RAN')">`;
  for (const file of ["archive.html", "reader.html"]) {
    const path = join(s.lib, p.dir, file);
    writeFileSync(path, readFileSync(path, "utf8").replace("</body>", `${plant}</body>`));
  }
  const messages: string[] = [];
  const onConsole = (m: ConsoleMessage) => messages.push(m.text());
  page.on("console", onConsole);
  page.on("pageerror", (e) => messages.push(e.message));
  const planted = () => messages.filter((m) => m.includes("PLANTED"));

  await openApp(page, s);
  await results(page).filter({ hasText: SOURDOUGH }).click();
  for (const view of ["Original", "Reader"]) {
    await page.getByRole("button", { name: view }).click();
    await expect(viewer(page)).toHaveAttribute("src", `/archive/${p.id}/${view.toLowerCase()}`);
    const frame = page.frameLocator("main iframe");
    // the planted elements reached the browser: the script was there to run, and did not
    await expect(frame.locator("script")).toHaveCount(1);
    await expect(frame.locator("#planted-img")).toHaveCount(1);
    // a script that ran logs at parse time and a handler on load; give a late one a moment
    await page.waitForTimeout(300);
    expect(planted(), `${view}: console`).toEqual([]);
    await expect(frame.locator("#planted-marker")).toHaveCount(0);
  }
  // opened as a page of its own, outside the sandbox, the CSP alone stops it
  await page.goto(`${s.url}archive/${p.id}/original`);
  await expect(page.locator("script")).toHaveCount(1);
  await expect(page.locator("#planted-img")).toHaveCount(1);
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  expect(planted(), "top level: console").toEqual([]);
  await expect(page.locator("#planted-marker")).toHaveCount(0);
});

test("re-capture saves the page again as its next version", async ({ page }) => {
  test.setTimeout(120_000);
  const s = await start(["plain-article"]);
  const p = s.pages.find((x) => x.url === fixtureUrl("plain-article"))!;
  await openApp(page, s);
  await results(page).filter({ hasText: p.title }).click();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(p.title);
  await page.getByRole("button", { name: "Re-capture" }).click();
  await expect(page.getByText("version 2 of 2")).toBeVisible({ timeout: 90_000 });
  const all = JSON.parse(await pa(s.lib, "list", "--json", "--all")) as PageRecord[];
  const versions = all.filter((x) => x.url === p.url);
  expect(versions.map((v) => v.version)).toEqual([2, 1]);
  expect(versions[0]!.versionOf).toBe(p.id);
  await expect(viewer(page)).toHaveAttribute("src", `/archive/${versions[0]!.id}/original`);
  // the list still shows the page once, as its newest version
  await expect(results(page)).toHaveCount(7);
  await expect(results(page).filter({ hasText: p.title })).toHaveAttribute("data-id", versions[0]!.id);
});
