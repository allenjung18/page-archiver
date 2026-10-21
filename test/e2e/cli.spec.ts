// `pa save <url> -o <file>` end to end: the built CLI captures a fixture into the named file.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
