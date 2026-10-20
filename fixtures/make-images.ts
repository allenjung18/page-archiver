// Writes the fixture images (deterministic gradients, each with a distinct hue so a wrong or
// missing image shows up in a screenshot diff). Run once with `npm run fixtures:images`; the
// PNGs are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const outDir = fileURLToPath(new URL("./assets/img/", import.meta.url));

export function gradient(width: number, height: number, hue: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const [r, g, b] = hsl(hue, 0.6, 0.35 + 0.4 * (x / width));
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
      // a 1px diagonal so scaling and offsets are visible
      if (Math.abs(x * (height / width) - y) < 1) png.data.fill(255, i, i + 3);
    }
  }
  return PNG.sync.write(png);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

export const IMAGES: ReadonlyArray<{ name: string; width: number; height: number; hue: number }> = [
  { name: "hero.png", width: 640, height: 240, hue: 210 },
  { name: "figure.png", width: 320, height: 180, hue: 30 },
  { name: "paper.png", width: 32, height: 32, hue: 50 },
  ...Array.from({ length: 8 }, (_, n) => ({
    name: `lazy-${n + 1}.png`,
    width: 480,
    height: 270,
    hue: (n * 45) % 360,
  })),
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  for (const img of IMAGES) {
    writeFileSync(outDir + img.name, gradient(img.width, img.height, img.hue));
  }
  console.log(`wrote ${IMAGES.length} images to ${outDir}`);
}
