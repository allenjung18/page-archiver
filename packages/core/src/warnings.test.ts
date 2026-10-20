import { describe, expect, it } from "vitest";
import { LARGE_ARCHIVE_BYTES, sizeWarning, summarizeWarnings } from "./warnings.ts";

describe("summarizeWarnings", () => {
  it("counts resources over a cap and resources that failed, and keeps the rest as they are", () => {
    expect(
      summarizeWarnings([
        "http://a.test/1.png: over the 25 MB per-resource cap (31 MB); set aside",
        "canvas #c is tainted by a cross-origin image and cannot be read; it is empty in the archive",
        "http://a.test/2.png: over the 25 MB per-resource cap (40 MB); set aside",
        "http://a.test/3.png: fetch failed (HTTP 404); set aside",
        "http://a.test/4.png: HTTP 500; set aside",
        "http://a.test/5.png: over the 200 MB total cap; set aside",
        "canvas #c is tainted by a cross-origin image and cannot be read; it is empty in the archive",
      ]),
    ).toEqual([
      "2 resources over the per-resource size cap, set aside",
      "canvas #c is tainted by a cross-origin image and cannot be read; it is empty in the archive",
      "2 resources could not be loaded, set aside",
      "1 resource over the page's total size cap, set aside",
    ]);
    expect(summarizeWarnings([])).toEqual([]);
  });

  it("counts video and audio left out of the archive on one line", () => {
    expect(
      summarizeWarnings([
        "video https://a.test/clip.mp4: media not archived; the poster frame is kept",
        "audio https://a.test/song.mp3: media not archived; nothing of it is kept",
        "video blob:https://a.test/9f2c: media not archived; it has no poster frame",
      ]),
    ).toEqual(["3 video or audio files not archived"]);
    expect(summarizeWarnings(["video https://a.test/v.mp4: media not archived; the poster frame is kept"])).toEqual(["1 video or audio file not archived"]);
  });

  it("warns about a large archive only past the limit", () => {
    expect(sizeWarning(LARGE_ARCHIVE_BYTES)).toBeNull();
    expect(sizeWarning(LARGE_ARCHIVE_BYTES + 1)).toBe("the archive is 50.0 MB (over 50 MB)");
  });
});
