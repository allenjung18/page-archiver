import { describe, expect, it } from "vitest";
import { parseSaveArgs, UsageError } from "./args.ts";

describe("parseSaveArgs", () => {
  it("reads the URL, the output file and the options", () => {
    expect(
      parseSaveArgs(["https://example.com/a", "-o", "a.html", "--profile", "p", "--wait-for", "#app", "--dismiss", ".ok", "--dismiss", "#accept", "--headed"]),
    ).toEqual({ url: "https://example.com/a", out: "a.html", profile: "p", waitFor: "#app", dismiss: [".ok", "#accept"], headed: true });
    expect(parseSaveArgs(["--out", "b.html", "http://x.test/"])).toEqual({ url: "http://x.test/", out: "b.html", dismiss: [], headed: false });
  });

  it("refuses what it cannot run", () => {
    for (const argv of [[], ["https://a.test/"], ["https://a.test/", "https://b.test/", "-o", "x"], ["nope", "-o", "x"], ["file:///etc/passwd", "-o", "x"], ["https://a.test/", "-o", "x", "--bogus"]]) {
      expect(() => parseSaveArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });
});
