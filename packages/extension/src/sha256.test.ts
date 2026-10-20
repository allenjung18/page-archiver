import { createHash as nodeHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHash } from "./shims/node-crypto.ts";
import { hex, sha256 } from "./sha256.ts";

const want = (b: Uint8Array) => nodeHash("sha256").update(b).digest("hex");

describe("sha256", () => {
  it("matches node:crypto at every padding edge and on large input", () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 1_000_003]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 0xff);
      expect(hex(sha256(bytes)), `${n} bytes`).toBe(want(bytes));
    }
  });

  it("hashes a view's own bytes, not its whole buffer", () => {
    const all = new Uint8Array(200).map((_, i) => i);
    const view = all.subarray(13, 150);
    expect(hex(sha256(view))).toBe(want(view.slice()));
  });

  it("the node:crypto stand-in hashes UTF-8 text like node:crypto, and refuses what it cannot do", () => {
    const text = "<html>café 日本 😀</html>";
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(nodeHash("sha256").update(text, "utf8").digest("hex"));
    expect(() => createHash("md5")).toThrow(/only sha256/);
    expect(() => createHash("sha256").update("x").digest("base64")).toThrow(/only hex/);
  });
});
