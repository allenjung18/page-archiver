// What a browser can run of core (the Chrome extension's service worker bundles this): assembling
// an archive from snapshots and resource bytes. No Node or Playwright import is reachable from
// here at run time except node:crypto's sha256 in stamp.ts, which the bundle replaces.
export { ARCHIVE_CSP, ARCHIVE_FILE, TOOL_NAME, TOOL_VERSION } from "./archive.ts";
export { assemble, buildFrame, type AssembleOptions, type Assembled, type BuildContext } from "./assemble.ts";
export { base64, utf8, utf8Length } from "./bytes.ts";
export { FRAME_ATTRIBUTE, MAX_FRAME_DEPTH, type FrameCapture } from "./frames.ts";
export { createResolver, type FallbackFetch, type Resolver, type Resource } from "./resources.ts";
export { DEFAULT_RESOURCE_CAP, DEFAULT_TOTAL_CAP } from "./recorder.ts";
export { verifyStamp } from "./stamp.ts";
