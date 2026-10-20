/** The file name of the self-contained page inside a capture's folder. */
export const ARCHIVE_FILE = "archive.html";

/**
 * The policy every archive is served and tested under. It allows nothing but inline styles and
 * data: URIs, so anything in an archive that still points at the network is refused by the
 * browser and shows up as a violation instead of silently loading.
 */
export const ARCHIVE_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline' data:",
  "font-src data:",
  "media-src data:",
  "frame-src data: about:",
].join("; ");

/** Written into every archive's page-archiver:tool-version meta. */
export const TOOL_NAME = "page-archiver";
export const TOOL_VERSION = "0.1.0";
