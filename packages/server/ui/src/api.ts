// The reader UI's calls to the local API. Writes carry the token the server wrote into the page.
import type { Facets, PageRecord } from "@page-archiver/library";

export type { Facet, Facets, PageRecord } from "@page-archiver/library";

export interface Segment {
  text: string;
  hit: boolean;
}

export type Hit = PageRecord & { snippet: Segment[]; score: number };

export interface Query {
  q: string;
  site: string;
  tag: string;
  since: string;
  until: string;
  all: boolean;
}

export interface VersionRef {
  id: string;
  capturedAt: string;
  version: number;
}

const token = document.querySelector<HTMLMetaElement>('meta[name="pa-token"]')?.content ?? "";

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `${method} ${path}: ${res.status}`);
  return data;
}

function params(query: Query): URLSearchParams {
  const p = new URLSearchParams();
  if (query.q.trim()) p.set("q", query.q.trim());
  if (query.site) p.set("site", query.site);
  if (query.tag) p.set("tag", query.tag);
  if (query.since) p.set("since", query.since);
  if (query.until) p.set("until", query.until);
  if (query.all) p.set("all", "1");
  return p;
}

/** Search when there are words to search for, else the list; both narrowed by the filters. */
export function find(query: Query): Promise<Array<PageRecord | Hit>> {
  const p = params(query);
  return p.has("q") ? call<Hit[]>("GET", `/api/search?${p}`) : call<PageRecord[]>("GET", `/api/pages?${p}`);
}

export const facets = () => call<Facets>("GET", "/api/facets");
export const page = (id: string) => call<{ page: PageRecord; versions: VersionRef[] }>("GET", `/api/pages/${encodeURIComponent(id)}`);
export const remove = (id: string) => call<{ deleted: string }>("DELETE", `/api/pages/${encodeURIComponent(id)}`);
export const recapture = (id: string) => call<{ page: PageRecord; warnings: string[] }>("POST", `/api/pages/${encodeURIComponent(id)}/recapture`);
export const tag = (id: string, add: string[], removeTags: string[] = []) =>
  call<PageRecord>("POST", `/api/pages/${encodeURIComponent(id)}/tags`, { add, remove: removeTags });

export const isHit = (p: PageRecord | Hit): p is Hit => "snippet" in p;
