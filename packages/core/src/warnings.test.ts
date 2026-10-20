import { describe, expect, it } from "vitest";
import { LARGE_ARCHIVE_BYTES, sizeWarning, summarizeWarnings } from "./warnings.ts";

describe("summarizeWarnings", () => {
  it("counts resources over a cap and resources that failed, and keeps the rest as they are", () => {
    expect(
      summarizeWarnings([
        "http://a.test/1.png: over the 25 MB per-resource cap (31 MB); kept as a link",
        "canvas #c is tainted by a cross-origin image and cannot be read; it is empty in the archive",
        "http://a.test/2.png: over the 25 MB per-resource cap (40 MB); kept as a link",
        "http://a.test/3.png: fetch failed (HTTP 404); kept as a link",
        "http://a.test/4.png: HTTP 500; kept as a link",
        "http://a.test/5.png: over the 200 MB total cap; kept as a link",
        "canvas #c is tainted by a cross-origin image and cannot be read; it is empty in the archive",
      ]),
    ).toEqual([
      "2 resources over the per-resource size cap, kept as links",
      "canvas #c is tainted by a cross-origin image and cannot be read; it is empty in the archive",
      "2 resources could not be loaded, kept as links",
      "1 resource over the page's total size cap, kept as links",
    ]);
    expect(summarizeWarnings([])).toEqual([]);
  });

  it("warns about a large archive only past the limit", () => {
    expect(sizeWarning(LARGE_ARCHIVE_BYTES)).toBeNull();
    expect(sizeWarning(LARGE_ARCHIVE_BYTES + 1)).toBe("the archive is 50.0 MB (over 50 MB)");
  });
});
