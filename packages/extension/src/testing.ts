// Fakes for the extension's unit tests (never bundled: nothing the build reaches imports it).
import type { StorageArea } from "./chrome.ts";

export function memoryStore(initial: Record<string, unknown> = {}): StorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of typeof keys === "string" ? [keys] : keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of typeof keys === "string" ? [keys] : keys) delete data[k];
    },
  };
}
