import { describe, expect, it } from "vitest";
import { dataUriLength, effectiveMime, normalizeMime, sniffMime, toDataUri } from "./datauri.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("datauri", () => {
  it("encodes bytes as base64 with the declared type, parameters dropped", () => {
    expect(toDataUri(Buffer.from("hi"), "image/png; foo=bar")).toBe("data:image/png;base64,aGk=");
  });

  it("marks text and SVG as utf-8 so non-ASCII survives", () => {
    const uri = toDataUri(Buffer.from("a{content:'é'}"), "text/css; charset=iso-8859-1");
    expect(uri.startsWith("data:text/css;charset=utf-8;base64,")).toBe(true);
    const back = Buffer.from(uri.split(",")[1]!, "base64").toString("utf8");
    expect(back).toBe("a{content:'é'}");
    expect(toDataUri(Buffer.from("<svg/>"), "image/svg+xml")).toMatch(/^data:image\/svg\+xml;charset=utf-8;base64,/);
  });

  it("sniffs a generic or missing type from the bytes", () => {
    expect(effectiveMime("application/octet-stream", PNG)).toBe("image/png");
    expect(effectiveMime(undefined, PNG)).toBe("image/png");
    expect(effectiveMime("", Buffer.from("<?xml version='1.0'?><svg></svg>"))).toBe("image/svg+xml");
    expect(effectiveMime("image/jpeg", PNG)).toBe("image/jpeg"); // a declared specific type wins
    expect(effectiveMime(null, Buffer.from("nothing"))).toBe("application/octet-stream");
  });

  it("knows the common signatures", () => {
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffMime(Buffer.from("wOF2xxxx"))).toBe("font/woff2");
    expect(sniffMime(Buffer.from("wOFFxxxx"))).toBe("font/woff");
    expect(sniffMime(Buffer.from("plain"))).toBeNull();
  });

  it("normalizes case and whitespace", () => {
    expect(normalizeMime(" Image/PNG ; x=1")).toBe("image/png");
  });

  it("predicts the encoded length", () => {
    for (const n of [0, 1, 2, 3, 4, 100]) {
      const bytes = new Uint8Array(n).fill(1);
      expect(dataUriLength(n, "image/png"), String(n)).toBe(toDataUri(bytes, "image/png").length);
    }
  });
});
