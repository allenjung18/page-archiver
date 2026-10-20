// What the extension bundle gets for `node:crypto`: createHash("sha256") over UTF-8 text, which
// is all core's stamp asks of it. Anything else throws, so a new use is noticed, not mis-hashed.
import { hex, sha256 } from "../sha256.ts";

export function createHash(algorithm: string) {
  if (algorithm !== "sha256") throw new Error(`createHash: only sha256 in the extension, not ${algorithm}`);
  const parts: Uint8Array[] = [];
  const hash = {
    update(data: string | Uint8Array, encoding?: string) {
      if (typeof data === "string" && encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8") throw new Error(`createHash.update: only utf8 text, not ${encoding}`);
      parts.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return hash;
    },
    digest(encoding: string) {
      if (encoding !== "hex") throw new Error(`createHash.digest: only hex, not ${encoding}`);
      const n = parts.reduce((s, p) => s + p.length, 0);
      const all = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      return hex(sha256(all));
    },
  };
  return hash;
}

export function randomBytes(): never {
  throw new Error("randomBytes is not available in the extension");
}
