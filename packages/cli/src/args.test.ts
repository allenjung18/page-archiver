import { describe, expect, it } from "vitest";
import { parseSaveArgs, UsageError } from "./args.ts";

const NOTHING_SKIPPED = { skip: { reader: false, mhtml: false, png: false, pdf: false } };

describe("parseSaveArgs", () => {
  it("reads the URL, the output file and the options", () => {
    expect(
      parseSaveArgs(["https://example.com/a", "-o", "a.html", "--profile", "p", "--wait-for", "#app", "--dismiss", ".ok", "--dismiss", "#accept", "--headed"]),
    ).toEqual({ url: "https://example.com/a", out: "a.html", profile: "p", waitFor: "#app", dismiss: [".ok", "#accept"], defaultDismiss: true, headed: true, ...NOTHING_SKIPPED, tags: [] });
    expect(parseSaveArgs(["--out", "b.html", "http://x.test/"])).toEqual({ url: "http://x.test/", out: "b.html", dismiss: [], defaultDismiss: true, headed: false, ...NOTHING_SKIPPED, tags: [] });
    expect(parseSaveArgs(["http://x.test/", "-o", "c.html", "--no-default-dismiss"]).defaultDismiss).toBe(false);
  });

  it("reads a folder capture: -d, tags and the extras turned off", () => {
    expect(parseSaveArgs(["https://example.com/a", "-d", "out", "--tag", "sea", "--tag", "tides"])).toEqual({
      url: "https://example.com/a",
      dir: "out",
      tags: ["sea", "tides"],
      dismiss: [],
      defaultDismiss: true,
      headed: false,
      ...NOTHING_SKIPPED,
    });
    expect(parseSaveArgs(["https://a.test/", "--dir", "o", "--no-pdf"]).skip).toEqual({ reader: false, mhtml: false, png: false, pdf: true });
    expect(parseSaveArgs(["https://a.test/", "-d", "o", "--no-shot"]).skip).toEqual({ reader: false, mhtml: false, png: true, pdf: true });
    expect(parseSaveArgs(["https://a.test/", "-d", "o", "--no-reader", "--no-mhtml"]).skip).toEqual({ reader: true, mhtml: true, png: false, pdf: false });
  });

  it("refuses what it cannot run", () => {
    for (const argv of [
      [],
      ["https://a.test/"],
      ["https://a.test/", "https://b.test/", "-o", "x"],
      ["nope", "-o", "x"],
      ["file:///etc/passwd", "-o", "x"],
      ["https://a.test/", "-o", "x", "--bogus"],
      ["https://a.test/", "-o", "x", "-d", "y"],
      ["https://a.test/", "-o", "x", "--tag", "t"],
      ["https://a.test/", "-o", "x", "--no-mhtml"],
    ]) {
      expect(() => parseSaveArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });
});
