import { describe, expect, it } from "vitest";
import { dataUriLength, effectiveMime, imageMime, normalizeMime, sniffMime, toDataUri, toListDataUri } from "./datauri.ts";

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

  it("finds an image by its declared type, or by a raster signature when the type is not an image's", () => {
    expect(imageMime("image/jpeg", PNG)).toBe("image/jpeg"); // a declared image type wins
    expect(imageMime("application/octet-stream", PNG)).toBe("image/png");
    expect(imageMime("text/html; charset=utf-8", PNG)).toBe("image/png");
    expect(imageMime("application/json", Buffer.from("GIF89a"))).toBe("image/gif");
    expect(imageMime("text/html", Buffer.from("<!doctype html>"))).toBeNull();
    // Chromium takes an SVG image only as image/svg+xml, and a font is never an image
    expect(imageMime("text/html", Buffer.from("<svg/>"))).toBeNull();
    expect(imageMime("", Buffer.from("<svg/>"))).toBe("image/svg+xml");
    expect(imageMime("application/json", Buffer.from("wOF2xxxx"))).toBeNull();
    expect(imageMime(null, Buffer.from(""))).toBeNull();
  });

  it("knows the common signatures", () => {
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffMime(Buffer.from("wOF2xxxx"))).toBe("font/woff2");
    expect(sniffMime(Buffer.from("wOFFxxxx"))).toBe("font/woff");
    expect(sniffMime(Uint8Array.from([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
    expect(sniffMime(Uint8Array.from([0, 1, 0, 0, 0, 9]))).toBe("font/ttf");
    expect(sniffMime(Buffer.from("OTTOxxxx"))).toBe("font/ttf");
    expect(sniffMime(Buffer.from("\0\0\0\x1cftypavifxx", "latin1"))).toBe("image/avif");
    expect(sniffMime(Buffer.from("\0\0\0\x1cftypmp42xx", "latin1"))).toBeNull();
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

describe("toListDataUri", () => {
  it("percent-encodes every byte but the unreserved ones, so the URI has no ';' and decodes to the same bytes", async () => {
    const bytes = Uint8Array.from([...PNG, 0x3b, 0x22, 0x28, 0x29, 0x27, 0x20, 0x25, 0x41, 0x7e, 0xff]);
    const uri = toListDataUri(bytes, "image/png; charset=binary");
    expect(uri.startsWith("data:image/png,%89PNG%0D%0A%1A%0A%00%00%00%0D%3B%22%28%29%27%20%25A~%FF")).toBe(true);
    expect(uri).not.toMatch(/[;"'() ]/);
    expect(new Uint8Array(await (await fetch(uri)).arrayBuffer())).toEqual(bytes);
  });

  it("sniffs a generic type as toDataUri does", () => {
    expect(toListDataUri(PNG, "application/octet-stream").startsWith("data:image/png,")).toBe(true);
  });
});
