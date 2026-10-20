// The in-page serializer. Chunk 1 adds snapshot(): the frozen DOM plus a manifest of every
// resource URL it references. Everything here must run in a page with no Node APIs.

export const SERIALIZER_VERSION = "0.0.0";
