// The in-page serializer: walks the live DOM into a frozen clone plus a manifest of every
// resource URL it references. Everything here must run in a page with no Node APIs; build.mjs
// bundles it to one IIFE (global PageArchiverSerializer) that core evaluates in the page.

export const SERIALIZER_VERSION = "0.1.0";

export { snapshot, type Snapshot, type SnapshotOptions } from "./snapshot.ts";
export { freezeImage, collapsePicture, LAZY_SRC_ATTRIBUTES } from "./images.ts";
