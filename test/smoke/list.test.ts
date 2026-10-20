import { describe, expect, it } from "vitest";
import { normalizeText, parseSmokeList, readSmokeList, splitViolations } from "./list.ts";

describe("parseSmokeList", () => {
  it("reads labels, urls, expected text and misses, skipping comments and blank lines", () => {
    const pages = parseSmokeList(
      ["# a comment", "", "docs | https://docs.example/a | Hello there", "wall | http://wall.example/ | Story | miss: bot wall in headless Chromium"].join("\n"),
    );
    expect(pages).toEqual([
      { label: "docs", url: "https://docs.example/a", expect: "Hello there", line: 3 },
      { label: "wall", url: "http://wall.example/", expect: "Story", miss: "bot wall in headless Chromium", line: 4 },
    ]);
  });

  it.each([
    ["too few fields", "docs | https://docs.example/a", /line 1: expected/],
    ["too many fields", "a | https://x.example/ | t | miss: r | extra", /line 1: expected/],
    ["a bad label", "my docs | https://x.example/ | t", /label/],
    ["a non-URL", "a | not a url | t", /not a URL/],
    ["a non-http URL", "a | file:///etc/passwd | t", /only http and https/],
    ["a fourth field that is not a miss", "a | https://x.example/ | t | flaky", /miss: <reason>/],
    ["an empty miss reason", "a | https://x.example/ | t | miss:", /miss: <reason>/],
  ])("refuses %s", (_name, line, error) => {
    expect(() => parseSmokeList(line)).toThrow(error);
  });

  it("refuses a label used twice", () => {
    expect(() => parseSmokeList("a | https://x.example/ | t\na | https://y.example/ | u")).toThrow(/line 2: label a is used twice/);
  });
});

describe("normalizeText", () => {
  it("lower-cases and collapses white space", () => {
    expect(normalizeText("  Hello\n\t  World ")).toBe("hello world");
  });
});

describe("the committed smoke list", () => {
  it("parses, and holds ten pages", () => {
    expect(readSmokeList()).toHaveLength(10);
  });
});

describe("splitViolations", () => {
  it("excuses only a violation whose URL a kept-as-a-link warning names", () => {
    const v = (blockedURI: string) => ({ directive: "img-src", blockedURI });
    const { reported, unreported } = splitViolations(
      [v("https://cdn.test/avatar.jpg"), v("https://cdn.test/other.jpg"), v("https://cdn.test/x.png"), v("")],
      [
        "https://cdn.test/avatar.jpg: HTTP 404; kept as a link",
        "https://cdn.test/x.png: alternate stylesheet dropped",
        "network not idle after 15 s (after load); captured anyway",
      ],
    );
    expect(reported.map((r) => r.blockedURI)).toEqual(["https://cdn.test/avatar.jpg"]);
    expect(unreported.map((r) => r.blockedURI)).toEqual(["https://cdn.test/other.jpg", "https://cdn.test/x.png", ""]);
  });
});
