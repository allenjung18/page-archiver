// Which hosts the service worker may fetch a page's resources from, and with whose cookies.
// The extension's host permission covers every site and every address, so without these rules a
// page could name a resource on the reader's own machine (`pa serve` at 127.0.0.1:47320, whose
// page carries its write token) or local network (a router, a cloud metadata address) and have
// the response inlined into its archive, or have the reader's cookies sent where the browser
// would not send them. The host rules are core's (hosts.ts), shared with `pa save`'s fallback.
import { getDomain } from "tldts";

export { hostClass, refusal, type HostClass } from "@page-archiver/core/portable";

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A host's site: its registrable domain (public suffix list, private entries included), else the host itself. */
function site(u: URL): string {
  return getDomain(u.hostname, { allowPrivateDomains: true }) ?? u.hostname;
}

/**
 * The credentials mode for fetching `target` for the page at `page`: the reader's cookies go
 * only to the page's own site (same registrable domain), as the browser sends a site's
 * SameSite cookies only to requests from that site; anything else is fetched without them.
 */
export function credentialsFor(target: string, page: string): RequestCredentials {
  const t = parse(target);
  const p = parse(page);
  if (!t || !p) return "omit";
  return t.origin === p.origin || site(t) === site(p) ? "include" : "omit";
}
