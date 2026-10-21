// `pa save <url> -o <file>` end to end: the built CLI captures a fixture into the named file.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { readStamp, verifyStamp } from "@page-archiver/core";
import { fixtureUrl } from "./env.ts";

const run = promisify(execFile);
const PA = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));

test("pa save <url> -o <file> writes a stamped, script-free archive", async () => {
  const out = test.info().outputPath("nested", "article.html");
  const url = fixtureUrl("plain-article");
  const { stdout, stderr } = await run(process.execPath, [PA, "save", url, "-o", out]);
  expect(stdout).toMatch(/^saved .*article\.html \(\d+(\.\d+)? (KB|MB)\)$/m);
  expect(stderr).toBe("");
  const html = readFileSync(out, "utf8");
  expect(readStamp(html)["source-url"]).toBe(url);
  expect(verifyStamp(html)).toBe(true);
  expect(html).not.toMatch(/<script|<link rel="stylesheet"/i);
  // links made absolute against the source URL
  expect(html).toContain(`href="${new URL("/other.html", url).href}"`);
  expect(html).toContain(`href="https://example.com/archive/ledger"`);
});

test("pa save with two places to write is a usage error", async () => {
  const err = await run(process.execPath, [PA, "save", fixtureUrl("plain-article"), "-o", "a.html", "-d", "dir"]).catch((e: { code: number; stderr: string }) => e);
  expect(err).toMatchObject({ code: 2 });
  expect((err as { stderr: string }).stderr).toMatch(/not --out and --dir/);
});

/** An environment with no browser opener on PATH (no open, xdg-open or explorer), as in a container. */
function noOpener(): NodeJS.ProcessEnv {
  const empty = test.info().outputPath("empty-path");
  mkdirSync(empty, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: empty };
  delete env["PA_NO_OPEN"];
  return env;
}

test("pa serve with no browser opener installed says so and keeps serving", async () => {
  const library = test.info().outputPath("lib");
  const child = spawn(process.execPath, [PA, "serve", "--port", "0", "--library", library], { env: noOpener(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    await expect.poll(() => stdout, { timeout: 15_000 }).toMatch(/write token: [0-9a-f]{48}/);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(child.exitCode, `pa serve exited; stderr: ${stderr}`).toBeNull();
    expect(stderr).toMatch(/^pa: could not open a browser \(.*\); open http:\/\/127\.0\.0\.1:\d+\/$/m);
  } finally {
    child.kill("SIGTERM");
  }
  expect(await exited).toBe(0);
});

test("pa open with no browser opener installed fails without saying it opened the page", async () => {
  const library = test.info().outputPath("lib");
  const file = fileURLToPath(new URL("../../fixtures/import/moss-garden.html", import.meta.url));
  const imported = await run(process.execPath, [PA, "import", file, "--library", library]);
  const id = /as ([0-9a-z]{12}) /.exec(imported.stdout)?.[1];
  expect(id, imported.stdout).toBeDefined();
  const err = await run(process.execPath, [PA, "open", id!, "--library", library], { env: noOpener() }).catch((e: { code: number; stdout: string; stderr: string }) => e);
  expect(err, "pa open exit code").toMatchObject({ code: 1 });
  expect((err as { stdout: string }).stdout).not.toMatch(/^opened /m);
  expect((err as { stderr: string }).stderr).toMatch(/^pa: could not open a browser \(.*\); open .*archive\.html$/m);
  expect((err as { stderr: string }).stderr, "no stack trace").not.toMatch(/\n\s+at /);
});

/** What `pa <args>` exits with and prints, in a library of the test's own (PA_LIBRARY is always set). */
async function pa(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, PA_LIBRARY: test.info().outputPath("exit-lib"), PA_NO_OPEN: "1" };
  try {
    const { stdout, stderr } = await run(process.execPath, [PA, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test("exit codes: 2 for a usage error, 1 for a failure at run time, 0 for help", async () => {
  expect(await pa(["frobnicate"])).toMatchObject({ code: 2, stderr: expect.stringContaining("pa: unknown command 'frobnicate'") });
  expect((await pa(["help"])).code).toBe(0);
  expect(await pa(["tag", "zzzzzzzz"])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^pa: no page with id zzzzzzzz/) });
  // a search with no hit, and an import of a file that is not there, are failures, not usage errors
  expect(await pa(["search", "nothingwillmatchthis"])).toMatchObject({ code: 1, stderr: expect.stringContaining("no matches for nothingwillmatchthis") });
  const missing = test.info().outputPath("missing.html");
  const good = test.info().outputPath("good.html");
  writeFileSync(good, `<!DOCTYPE html><html><!--\n Page saved with SingleFile\n url: https://import.example/good\n saved date: 2026-03-12T10:00:00Z\n--><head><meta charset="utf-8"><title>Good import</title></head><body><article><h1>Good import</h1><p>Some ordinary prose, long enough to be worth keeping as the main text of a page.</p></article></body></html>`);
  // one bad file among good ones still fails the command, and the good one is imported
  const bad = await pa(["import", missing, good]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toMatch(/^pa: .*missing\.html: /m);
  expect(bad.stdout).toContain(`imported ${good} as `);
  // a page that cannot be loaded at all
  const closed = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
  const save = await pa(["save", `http://127.0.0.1:${closed}/`]);
  expect(save.code).toBe(1);
  expect(save.stderr).toMatch(/^pa: /m);
});

test("pa serve on a port in use exits 1 and names --port", async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = (holder.address() as { port: number }).port;
  try {
    const res = await pa(["serve", "--no-open", "--port", String(port), "--library", test.info().outputPath("busy-lib")]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`pa: port ${port} is in use: pass another with --port`);
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});
