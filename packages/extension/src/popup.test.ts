import { describe, expect, it } from "vitest";
import { describe as describeResult, parseTags } from "./popup.ts";

describe("the popup", () => {
  it("reads tags split by commas or spaces, without empties or repeats", () => {
    expect(parseTags(" news, long-read  news,,ideas ")).toEqual(["news", "long-read", "ideas"]);
    expect(parseTags("   ")).toEqual([]);
  });

  it("says what happened", () => {
    expect(describeResult({ kind: "saved", url: "u", title: "t", pageId: "p", libraryUrl: "l", warnings: [] })).toBe("Saved ✓");
    expect(describeResult({ kind: "saved", url: "u", title: "t", pageId: "p", libraryUrl: "l", warnings: ["a", "b"] })).toBe("Saved ✓ (2 warnings)");
    expect(describeResult({ kind: "downloaded", url: "u", title: "t", filename: "page-archiver/x.html", downloadId: 1, reason: "the library server is not running", warnings: [] })).toBe(
      "Downloaded x.html instead: the library server is not running",
    );
    expect(describeResult({ kind: "saved", url: "u", title: "t", pageId: "p", libraryUrl: "l", warnings: ["a"] }), "one warning is singular").toBe("Saved ✓ (1 warning)");
    expect(describeResult({ kind: "downloaded", url: "u", title: "t", filename: "x.html", downloadId: 1, reason: "r", warnings: ["a"] })).toBe("Downloaded x.html instead: r (1 warning)");
    expect(describeResult({ kind: "failed", url: "u", error: "boom" })).toBe("Not saved: boom");
  });
});
