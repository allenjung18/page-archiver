// Proves the offline harness itself can see what offline.spec.ts asserts is absent: a request
// to the network, a CSP violation, a script. Without this, "zero blocked, zero violations"
// could be a harness that never looks.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { gradient } from "../../fixtures/make-images.ts";
import { ASSETS_ORIGIN } from "./env.ts";
import { openOffline } from "./offline.ts";

const dataPng = `data:image/png;base64,${gradient(64, 32, 120).toString("base64")}`;

function page(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;
}

test("a self-contained archive opens with nothing blocked and no violations", async ({ browser }, testInfo) => {
  const file = testInfo.outputPath("self-contained.html");
  writeFileSync(
    file,
    page(
      `<h1>inline only</h1><img src="${dataPng}" width="64" height="32" alt="">`,
      `<style>body{background:url("${dataPng}");font:16px Georgia,serif}</style>`,
    ),
  );
  const opened = await openOffline(browser, file);
  expect(opened.blocked).toEqual([]);
  expect(opened.violations).toEqual([]);
  expect(opened.screenshot.byteLength).toBeGreaterThan(0);
});

test("network references in an archive are CSP violations", async ({ browser }, testInfo) => {
  const file = testInfo.outputPath("leaky.html");
  writeFileSync(
    file,
    page(
      `<img src="${ASSETS_ORIGIN}/img/hero.png" alt=""><script>document.title = "ran"</script>`,
      `<link rel="stylesheet" href="${ASSETS_ORIGIN}/css/article.css">`,
    ),
  );
  const opened = await openOffline(browser, file);
  const directives = opened.violations.map((v) => v.directive).sort();
  expect(directives).toEqual(["img-src", "script-src-elem", "style-src-elem"]);
  expect(opened.violations.find((v) => v.directive === "img-src")?.blockedURI).toBe(
    `${ASSETS_ORIGIN}/img/hero.png`,
  );
});

test("without the CSP, a network reference is caught by the route as a blocked request", async ({
  browser,
}, testInfo) => {
  const file = testInfo.outputPath("leaky-no-csp.html");
  writeFileSync(file, page(`<img src="${ASSETS_ORIGIN}/img/hero.png" alt="">`));
  const opened = await openOffline(browser, file, { csp: false });
  expect(opened.violations).toEqual([]);
  expect(opened.blocked).toEqual([`image ${ASSETS_ORIGIN}/img/hero.png`]);
});
