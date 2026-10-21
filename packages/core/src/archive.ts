/** The file name of the self-contained page inside a capture's folder. */
export const ARCHIVE_FILE = "archive.html";

/**
 * The policy every archive is served and tested under. It allows nothing but inline styles and
 * data: URIs, so anything in an archive that still points at the network is refused by the
 * browser and shows up as a violation instead of silently loading. Frames come from about: only
 * (a captured frame is a srcdoc; the sanitizer strips a data: document from a frame). An archive
 * opened as a page of its own is sandboxed (an opaque origin, never the server's; no forms, no
 * popups), may submit a form nowhere and may not set its base URL. The sandbox allows scripts
 * only because a sandbox without it makes Chromium draw native controls on every <video>,
 * which changes how the archive looks; no script runs all the same, since there is no
 * script-src and default-src is 'none'.
 */
export const ARCHIVE_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline' data:",
  "font-src data:",
  "media-src data:",
  "frame-src about:",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

/** Written into every archive's page-archiver:tool-version meta. */
export const TOOL_NAME = "page-archiver";
export const TOOL_VERSION = "0.1.0";
