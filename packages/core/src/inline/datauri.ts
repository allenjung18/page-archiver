// Bytes + MIME type -> data: URI. The MIME type comes from the response; when it is missing or
// generic the bytes are sniffed for the common image and font signatures, because a data: URI
// with the wrong type renders nothing.
import { base64, utf8 } from "../bytes.ts";

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "text/plain"]);

/** The MIME type without parameters, lower case; text types keep `;charset=utf-8`. */
export function normalizeMime(mime: string | undefined | null): string {
  const base = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return base;
}

/** Recognises an image or font by its first bytes; null when unknown. */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (starts([0x77, 0x4f, 0x46, 0x32])) return "font/woff2";
  if (starts([0x77, 0x4f, 0x46, 0x46])) return "font/woff";
  if (starts([0x00, 0x01, 0x00, 0x00]) || starts([0x4f, 0x54, 0x54, 0x4f])) return "font/ttf";
  if (starts([0x66, 0x74, 0x79, 0x70], 4) && starts([0x61, 0x76, 0x69, 0x66], 8)) return "image/avif";
  const head = utf8(b.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/** The MIME type to put in a data: URI for these bytes. */
export function effectiveMime(mime: string | undefined | null, bytes: Uint8Array): string {
  const declared = normalizeMime(mime);
  if (!GENERIC.has(declared)) return declared;
  return sniffMime(bytes) ?? (declared || "application/octet-stream");
}

/** A base64 data: URI. Text types (CSS, SVG) are marked utf-8 so non-ASCII survives. */
export function toDataUri(bytes: Uint8Array, mime: string | undefined | null): string {
  const type = effectiveMime(mime, bytes);
  const charset = type.startsWith("text/") || type === "image/svg+xml" ? ";charset=utf-8" : "";
  return `data:${type}${charset};base64,${base64(bytes)}`;
}

/** The encoded length of a base64 data: URI for n bytes, without building it. */
export function dataUriLength(n: number, mime: string): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(n / 3);
}
