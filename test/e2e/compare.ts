import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface Diff {
  /** Fraction of pixels that differ, 0..1. A size mismatch counts as 1. */
  ratio: number;
  /** One line for an assertion message. */
  detail: string;
  /** The pixelmatch diff image, when the sizes matched. */
  diffPng?: Buffer;
}

/** Compares two PNG screenshots pixel by pixel (pixelmatch, anti-aliasing tolerated). */
export function diffScreenshots(expected: Buffer, actual: Buffer): Diff {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      ratio: 1,
      detail: `size differs: expected ${a.width}x${a.height}, got ${b.width}x${b.height}`,
    };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const ratio = changed / (a.width * a.height);
  return {
    ratio,
    detail: `${changed} of ${a.width * a.height} pixels differ (${(ratio * 100).toFixed(3)}%)`,
    diffPng: PNG.sync.write(diff),
  };
}
