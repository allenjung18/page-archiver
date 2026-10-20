// Byte helpers that run in Node and in a browser alike: the archive is assembled in Node by
// capture() and in the Chrome extension's service worker, which has no Buffer.

type BufferLike = { from(b: ArrayBufferLike, offset: number, length: number): { toString(enc: "base64"): string } };

/** The bytes as base64 (Buffer in Node; btoa over chunks elsewhere). */
export function base64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let out = "";
  const CHUNK = 0x8000; // a multiple of 3, so each chunk's base64 joins the next without padding
  for (let i = 0; i < bytes.length; i += CHUNK * 3) {
    let bin = "";
    const part = bytes.subarray(i, i + CHUNK * 3);
    for (let j = 0; j < part.length; j += CHUNK) bin += String.fromCharCode(...part.subarray(j, j + CHUNK));
    out += btoa(bin);
  }
  return out;
}

/** The bytes decoded as UTF-8 (malformed sequences become U+FFFD; a leading BOM is kept). */
export function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** The length of s encoded as UTF-8 (a lone surrogate counts as U+FFFD, 3 bytes), without encoding it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
