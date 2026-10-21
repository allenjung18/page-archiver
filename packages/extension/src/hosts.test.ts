import { describe, expect, it } from "vitest";
import { credentialsFor, hostClass, refusal } from "./hosts.ts";

const host = (url: string) => new URL(url).hostname;

describe("hostClass", () => {
  it.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://127.255.0.9/", "loopback"],
    ["http://2130706433/", "loopback"],
    ["http://0x7f.1/", "loopback"],
    ["http://localhost/", "loopback"],
    ["http://LOCALHOST./", "loopback"],
    ["http://app.localhost/", "loopback"],
    ["http://[::1]/", "loopback"],
    ["http://[::ffff:127.0.0.1]/", "loopback"],
    ["http://10.0.0.1/", "private network"],
    ["http://172.16.0.1/", "private network"],
    ["http://172.31.255.255/", "private network"],
    ["http://192.168.1.1/", "private network"],
    ["http://[::ffff:192.168.1.1]/", "private network"],
    ["http://[fc00::1]/", "private network"],
    ["http://[fd12:3456::1]/", "private network"],
    ["http://169.254.169.254/", "link-local"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[febf::1]/", "link-local"],
    ["http://0.0.0.0/", "unspecified"],
    ["http://[::]/", "unspecified"],
  ])("%s is %s", (url, kind) => {
    expect(hostClass(host(url))).toBe(kind);
  });

  it.each(["http://8.8.8.8/", "http://11.0.0.1/", "http://172.15.0.1/", "http://172.32.0.1/", "http://192.169.0.1/", "http://169.255.0.1/", "http://[2001:db8::1]/", "http://[fec0::1]/", "http://[::ffff:8.8.8.8]/", "https://example.com/", "https://localhost.example.com/"])(
    "%s is public",
    (url) => {
      expect(hostClass(host(url))).toBeNull();
    },
  );
});

describe("refusal", () => {
  const PAGE = "https://site.test/article";

  it.each([
    ["http://127.0.0.1:47320/", /^a loopback address/],
    ["http://localhost:3000/a.png", /^a loopback address/],
    ["http://[::1]/a.png", /^a loopback address/],
    ["http://192.168.0.1/x.png", /^a private network address/],
    ["http://10.1.2.3/x.png", /^a private network address/],
    ["http://[fd00::5]/x.png", /^a private network address/],
    ["http://169.254.169.254/latest/meta-data/", /^a link-local address/],
    ["http://0.0.0.0:47320/", /^an unspecified address/],
  ])("a public page cannot reach %s", (target, why) => {
    expect(refusal(target, PAGE)).toMatch(why);
  });

  it("lets a public page fetch public resources", () => {
    expect(refusal("https://cdn.test/i.png", PAGE)).toBeNull();
    expect(refusal("https://site.test/s.css", PAGE)).toBeNull();
  });

  it("lets a page on a private host fetch its own host's resources, on any port", () => {
    expect(refusal("http://127.0.0.1:8080/x.png", "http://127.0.0.1:8080/page.html")).toBeNull();
    expect(refusal("http://127.0.0.1:47311/img/a.png", "http://127.0.0.1:47310/page.html")).toBeNull();
    expect(refusal("http://192.168.1.5/a.png", "http://192.168.1.5:8000/")).toBeNull();
  });

  it("refuses a private host other than the page's own, even from a private page", () => {
    expect(refusal("http://192.168.1.6/a.png", "http://192.168.1.5/")).toMatch(/^a private network address/);
    expect(refusal("http://localhost:3000/a.png", "http://127.0.0.1:3000/")).toMatch(/^a loopback address/);
  });

  it("refuses the library server from any other page, by any loopback name", () => {
    const server = "http://127.0.0.1:47320/";
    expect(refusal("http://127.0.0.1:47320/", "http://127.0.0.1:3000/", server)).toMatch(/the page-archiver server/);
    expect(refusal("http://localhost:47320/x", "http://localhost:3000/", server)).toMatch(/the page-archiver server/);
    expect(refusal("http://127.0.0.1:47320/archive/x/original", "http://127.0.0.1:47320/", server)).toBeNull();
    expect(refusal("http://127.0.0.1:47321/", "http://127.0.0.1:3000/", server)).toBeNull();
  });

  it("leaves a URL it cannot parse to the fetch", () => {
    expect(refusal("not a url", PAGE)).toBeNull();
  });
});

describe("credentialsFor", () => {
  it("sends the reader's cookies to the page's own site only", () => {
    expect(credentialsFor("https://site.test/s.css", "https://site.test/article")).toBe("include");
    expect(credentialsFor("https://files.slack.com/f.png", "https://app.slack.com/client")).toBe("include");
    expect(credentialsFor("http://127.0.0.1:47311/a.png", "http://127.0.0.1:47310/")).toBe("include");
    expect(credentialsFor("https://cdn.test/i.png", "https://site.test/article")).toBe("omit");
    expect(credentialsFor("https://b.github.io/x.png", "https://a.github.io/")).toBe("omit");
    expect(credentialsFor("not a url", "https://site.test/")).toBe("omit");
  });
});
