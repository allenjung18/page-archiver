import { describe, expect, it } from "vitest";
import { parseLibraryArgs, parseSaveArgs, UsageError } from "./args.ts";

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
      ["https://a.test/", "https://b.test/", "-o", "x"],
      ["nope", "-o", "x"],
      ["file:///etc/passwd", "-o", "x"],
      ["https://a.test/", "-o", "x", "--bogus"],
      ["https://a.test/", "-o", "x", "-d", "y"],
      ["https://a.test/", "-o", "x", "--tag", "t"],
      ["https://a.test/", "-o", "x", "--no-mhtml"],
      ["https://a.test/", "-o", "x", "--library", "l"],
      ["https://a.test/", "-d", "x", "--library", "l"],
    ]) {
      expect(() => parseSaveArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("saves into the library when neither -o nor -d is given", () => {
    expect(parseSaveArgs(["https://a.test/"])).toEqual({ url: "https://a.test/", tags: [], dismiss: [], defaultDismiss: true, headed: false, ...NOTHING_SKIPPED });
    expect(parseSaveArgs(["https://a.test/", "--library", "lib", "--tag", "t", "--no-pdf"])).toMatchObject({ library: "lib", tags: ["t"], skip: { pdf: true } });
  });
});

describe("parseLibraryArgs", () => {
  it("reads list and search with their filters", () => {
    expect(parseLibraryArgs("list", ["--all", "--site", "s", "--tag", "a", "--tag", "b", "--since", "2026-01-01", "--until", "2026-02-01", "--limit", "5", "--json", "--library", "l"])).toEqual({
      command: "list",
      library: "l",
      site: "s",
      tags: ["a", "b"],
      since: "2026-01-01",
      until: "2026-02-01",
      allVersions: true,
      limit: 5,
      json: true,
    });
    expect(parseLibraryArgs("search", ["fog", "bell", "--raw"])).toEqual({ command: "search", query: "fog bell", raw: true, tags: [], allVersions: false, json: false });
  });

  it("reads tag, open, reindex and import", () => {
    expect(parseLibraryArgs("tag", ["abcd", "x", "y", "--remove", "z"])).toEqual({ command: "tag", id: "abcd", add: ["x", "y"], remove: ["z"] });
    expect(parseLibraryArgs("open", ["abcd", "--reader", "--print"])).toEqual({ command: "open", id: "abcd", reader: true, print: true });
    expect(parseLibraryArgs("reindex", ["--library", "l"])).toEqual({ command: "reindex", library: "l" });
    expect(parseLibraryArgs("import", ["a.html", "b.html", "--tag", "t"])).toEqual({ command: "import", files: ["a.html", "b.html"], tags: ["t"] });
    expect(parseLibraryArgs("import", ["a.html", "--url", "https://a.test/"])).toMatchObject({ url: "https://a.test/" });
  });

  it("refuses what it cannot run", () => {
    for (const [command, argv] of [
      ["list", ["extra"]],
      ["list", ["--limit", "0"]],
      ["list", ["--limit", "x"]],
      ["list", ["--bogus"]],
      ["search", []],
      ["search", ["--json"]],
      ["tag", []],
      ["open", []],
      ["open", ["a", "b"]],
      ["reindex", ["x"]],
      ["import", []],
      ["import", ["a.html", "b.html", "--url", "https://a.test/"]],
      ["import", ["a.html", "--url", "ftp://a.test/"]],
    ] as const) {
      expect(() => parseLibraryArgs(command, [...argv]), `${command} ${argv.join(" ")}`).toThrow(UsageError);
    }
  });
});
