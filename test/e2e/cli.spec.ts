// `pa save <url> -o <file>` end to end: the built CLI captures a fixture into the named file.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
