import { describe, expect, it } from "vitest";
import { ARCHIVE_CSP } from "./archive.ts";

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe("ARCHIVE_CSP", () => {
  const d = directives(ARCHIVE_CSP);

  it("denies everything by default", () => {
    expect(d.get("default-src")).toEqual(["'none'"]);
  });

  it("allows no network scheme and no script source", () => {
    for (const [name, sources] of d) {
      expect(name).not.toBe("script-src");
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toMatch(/^(https?:|ws:|wss:|\*|'self')/);
      }
    }
  });

  it("allows data: for every resource kind an archive inlines", () => {
    for (const name of ["img-src", "style-src", "font-src", "media-src"]) {
      expect(d.get(name), name).toContain("data:");
    }
  });

  // the sanitizer strips a data: document from a frame (DOCUMENT_URL_ATTRIBUTES); a captured
  // frame is a srcdoc, and an empty one about:blank
  it("allows frames from about: only, never a data: document", () => {
    expect(d.get("frame-src")).toEqual(["about:"]);
  });

  // opened at /archive/:id/original as a page of its own, an archive must not act with the
  // server's origin, submit a form anywhere or move its base URL
  // allow-scripts only: a sandbox without it draws native controls on every <video>; scripts
  // are refused by default-src 'none' (above), forms and popups by the sandbox
  it("sandboxes the archive, and refuses form targets and <base>", () => {
    expect(d.get("sandbox")).toEqual(["allow-scripts"]);
    expect(d.get("form-action")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
  });
});
