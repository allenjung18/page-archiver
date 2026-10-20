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
    for (const name of ["img-src", "style-src", "font-src", "media-src", "frame-src"]) {
      expect(d.get(name), name).toContain("data:");
    }
  });
});
