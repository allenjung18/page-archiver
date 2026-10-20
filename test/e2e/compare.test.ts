import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { diffScreenshots } from "./compare.ts";

function solid(width: number, height: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return png;
}

const write = (png: PNG) => PNG.sync.write(png);

describe("diffScreenshots", () => {
  it("is 0 for identical images", () => {
    const img = write(solid(20, 10, [10, 20, 30]));
    expect(diffScreenshots(img, img).ratio).toBe(0);
  });

  it("counts changed pixels as a fraction of the image", () => {
    const a = solid(20, 10, [255, 255, 255]);
    const b = solid(20, 10, [255, 255, 255]);
    for (const x of [0, 1]) b.data.set([0, 0, 0, 255], x * 4); // two black pixels in row 0
    const d = diffScreenshots(write(a), write(b));
    expect(d.ratio).toBeCloseTo(2 / 200, 10);
    expect(d.detail).toContain("2 of 200 pixels differ");
    expect(d.diffPng).toBeInstanceOf(Buffer);
  });

  it("treats a size mismatch as a total difference", () => {
    const d = diffScreenshots(write(solid(20, 10, [0, 0, 0])), write(solid(20, 11, [0, 0, 0])));
    expect(d.ratio).toBe(1);
    expect(d.detail).toBe("size differs: expected 20x10, got 20x11");
  });
});
