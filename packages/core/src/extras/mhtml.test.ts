import { describe, expect, it } from "vitest";
import { MhtmlError, parseMhtml } from "./mhtml.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250]);

function sample(opts: { close?: boolean; boundary?: string } = {}): string {
  const b = opts.boundary ?? "----MultipartBoundary--abc123----";
  const lines = [
    "From: <Saved by Blink>",
    "Snapshot-Content-Location: http://pages.test/a.html",
    "Subject: A page",
    "MIME-Version: 1.0",
    "Content-Type: multipart/related;",
    `\ttype="text/html";`,
    `\tboundary="${b}"`,
    "",
    "",
    `--${b}`,
    "Content-Type: text/html",
    "Content-ID: <frame-1@mhtml.blink>",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Location: http://pages.test/a.html",
    "",
    `<html><head><meta charset=3D"utf-8"></head><body><p>caf=C3=A9 and a very long line that is=`,
    ` folded</p></body></html>`,
    `--${b}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Location: http://assets.test/i.png",
    "",
    PNG.toString("base64").slice(0, 8),
    PNG.toString("base64").slice(8),
    "",
  ];
  if (opts.close !== false) lines.push(`--${b}--`, "");
  return lines.join("\r\n");
}

describe("parseMhtml", () => {
  it("reads the headers, the boundary and every part, decoded", () => {
    const m = parseMhtml(sample());
    expect(m.boundary).toBe("----MultipartBoundary--abc123----");
    expect(m.headers["snapshot-content-location"]).toBe("http://pages.test/a.html");
    expect(m.headers["content-type"]).toMatch(/^multipart\/related; type="text\/html"; boundary=/);
    expect(m.parts.map((p) => [p.type, p.location])).toEqual([
      ["text/html", "http://pages.test/a.html"],
      ["image/png", "http://assets.test/i.png"],
    ]);
    expect(m.parts[0]!.body.toString("utf8")).toBe(`<html><head><meta charset="utf-8"></head><body><p>café and a very long line that is folded</p></body></html>`);
    expect(m.parts[1]!.body.equals(PNG)).toBe(true);
  });

  it("accepts bare LF line ends", () => {
    expect(parseMhtml(sample().replaceAll("\r\n", "\n")).parts).toHaveLength(2);
  });

  it("refuses what is not well formed", () => {
    const cases: Array<[string, RegExp]> = [
      [sample({ close: false }), /no closing delimiter/],
      [sample().replace(/Content-Type: multipart\/related;/, "Content-Type: text/html;"), /not multipart\/related/],
      [sample().replace(/\tboundary="[^"]+"/, "\tcharset=x"), /no boundary/],
      [sample().replace("Content-Type: image/png\r\n", ""), /part 2 .* no Content-Type|part 2 has no Content-Type/],
      [sample().replace("caf=C3=A9", "caf=ZZ"), /part 1 .*bad quoted-printable escape =ZZ/],
      [sample().replace(PNG.toString("base64").slice(8), "!!!"), /part 2 .*bad base64/],
      [sample().replace("Content-Transfer-Encoding: base64", "Content-Transfer-Encoding: x-gzip"), /unknown Content-Transfer-Encoding x-gzip/],
      ["no headers at all", /no empty line/],
    ];
    for (const [text, why] of cases) expect(() => parseMhtml(text), String(why)).toThrow(why);
    expect(() => parseMhtml(sample({ close: false }))).toThrow(MhtmlError);
  });
});
