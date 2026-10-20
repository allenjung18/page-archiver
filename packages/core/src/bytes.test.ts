import { describe, expect, it } from "vitest";
import { base64, utf8, utf8Length } from "./bytes.ts";

function withoutBuffer<T>(fn: () => T): T {
  const g = globalThis as { Buffer?: unknown };
  const saved = g.Buffer;
  delete g.Buffer;
  try {
    return fn();
  } finally {
    g.Buffer = saved;
  }
}

describe("base64", () => {
  const sizes = [0, 1, 2, 3, 4, 0x8000 * 3 - 1, 0x8000 * 3, 0x8000 * 3 + 2, 300_001];
  for (const n of sizes) {
    it(`matches Buffer for ${n} bytes, with and without Buffer`, () => {
      const bytes = new Uint8Array(n).map((_, i) => (i * 7919) & 0xff);
      const want = Buffer.from(bytes).toString("base64");
      expect(base64(bytes)).toBe(want);
      expect(withoutBuffer(() => base64(bytes))).toBe(want);
    });
  }

  it("reads only the view's own bytes", () => {
    const all = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = all.subarray(2, 5);
    expect(withoutBuffer(() => base64(view))).toBe(Buffer.from([3, 4, 5]).toString("base64"));
    expect(base64(view)).toBe(Buffer.from([3, 4, 5]).toString("base64"));
  });
});

describe("utf8 and utf8Length", () => {
  const samples = ["", "plain", "café", "日本語", "emoji 😀 pair", "lone \ud800 high", "lone \udc00 low", "end \ud83d"];
  for (const s of samples) {
    it(`agrees with Buffer for ${JSON.stringify(s)}`, () => {
      expect(utf8Length(s)).toBe(Buffer.byteLength(s));
      expect(utf8(Buffer.from(s))).toBe(Buffer.from(s).toString("utf8"));
    });
  }

  it("keeps a leading BOM, as Buffer does", () => {
    expect(utf8(Buffer.from("﻿body{}"))).toBe("﻿body{}");
  });
});
