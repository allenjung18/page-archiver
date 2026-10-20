// Proves the offline harness itself can see what offline.spec.ts asserts is absent: a request
// to the network, a CSP violation, a script. Without this, "zero blocked, zero violations"
// could be a harness that never looks.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { gradient } from "../../fixtures/make-images.ts";
import { ASSETS_ORIGIN } from "./env.ts";
import { openOffline } from "./offline.ts";

const dataPng = `data:image/png;base64,${gradient(64, 32, 120).toString("base64")}`;

/** A PNG of seeded noise: large and incompressible, so Chromium decodes it off the main thread. */
function noisePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  let x = 2463534242; // xorshift32: no short cycles in the low bits, so nothing compresses
  for (let i = 0; i < png.data.length; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    png.data[i] = (x >>> 25) & 0x7f;
    png.data[i + 1] = (x >>> 17) & 0x7f;
    png.data[i + 2] = (x >>> 9) & 0x7f;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

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

// Found on a real product page: large decoding="async" images below the fold were in the archive
// but not yet painted when the full-page screenshot was taken, so they came out blank.
test("large decoding=async images below the fold are in the screenshot", async ({ browser }, testInfo) => {
  const noise = `data:image/png;base64,${noisePng(1400, 1000).toString("base64")}`;
  const images = Array.from(
    { length: 5 },
    () => `<div style="margin:200px 0"><img decoding="async" src="${noise}" style="display:block;width:520px;height:371px" alt=""></div>`,
  ).join("");
  const file = testInfo.outputPath("async-images.html");
  writeFileSync(file, page(`<div style="height:1200px">top</div>${images}`, `<style>body{margin:0;background:#fff}</style>`));
  let tops: number[] = [];
  const opened = await openOffline(browser, file, {
    inspect: async (p) => {
      tops = await p.evaluate(() => [...document.images].map((i) => Math.round(i.getBoundingClientRect().top + scrollY)));
    },
  });
  const shot = PNG.sync.read(opened.screenshot);
  // the noise never reaches 255 in any channel, the page background is white
  const blank = tops.filter((top) => {
    const o = ((top + 100) * shot.width + 100) * 4;
    return shot.data[o] === 255 && shot.data[o + 1] === 255 && shot.data[o + 2] === 255;
  });
  expect(tops).toHaveLength(5);
  expect(blank, "images photographed before they were painted").toEqual([]);
});
