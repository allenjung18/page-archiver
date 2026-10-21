// Which hosts a capture may fetch a page's resources from itself. Whatever fetches from outside
// the page (core's capture fallback, run from Node; the extension's service worker, whose host
// permission covers every address) is outside the browser's own private-network checks, so
// without these rules a page could name a resource on the reader's own machine (`pa serve` at
// 127.0.0.1:47320, whose page carries its write token) or local network (a router, a cloud
// metadata address) and have the response inlined into its archive.

/** The kind of address a host names when it is not a public one. */
export type HostClass = "loopback" | "private network" | "link-local" | "unspecified";

/** A URL hostname's class (as `new URL()` writes it: lowercase, IPv4 dotted, IPv6 bracketed), or null when public. */
export function hostClass(hostname: string): HostClass | null {
  const name = hostname.replace(/\.$/, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (v4) return ipv4Class(Number(v4[1]), Number(v4[2]));
  const g = ipv6Groups(name);
  if (!g) return null;
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // an IPv4-mapped address (::ffff:a.b.c.d) is the IPv4 address it maps
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4Class(g[6]! >> 8, g[6]! & 0xff);
  if ((g[0]! & 0xfe00) === 0xfc00) return "private network";
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
  return null;
}

function ipv4Class(a: number, b: number): HostClass | null {
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private network";
  if (a === 169 && b === 254) return "link-local";
  if (a === 0) return "unspecified";
  return null;
}

/** A bracketed IPv6 hostname's eight groups, or null. */
function ipv6Groups(name: string): number[] | null {
  if (!name.startsWith("[") || !name.endsWith("]")) return null;
  const halves = name.slice(1, -1).split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part ? part.split(":").map((x) => parseInt(x, 16)) : []);
  const head = groups(halves[0]!);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = groups(halves[1]!);
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const ARTICLE: Record<HostClass, string> = { loopback: "a", "private network": "a", "link-local": "a", unspecified: "an" };

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

/** Whether `u` reaches the library server at `server`: same scheme and port, and the same host or both loopback. */
function isServer(u: URL, server: URL): boolean {
  if (u.protocol !== server.protocol || port(u) !== port(server)) return false;
  return u.hostname === server.hostname || (hostClass(u.hostname) === "loopback" && hostClass(server.hostname) === "loopback");
}

/**
 * Why the resource at `target` is not fetched for the page at `page`, or null when it may be.
 * A loopback, private-network, link-local or unspecified address is refused unless it is the
 * page's own host (a page served from the reader's machine keeps its assets on another port);
 * the library server (`server`) is refused, by any loopback name, unless it is the page itself.
 */
export function refusal(target: string, page: string, server?: string): string | null {
  const t = parse(target);
  const p = parse(page);
  if (!t || !p) return null;
  const kind = hostClass(t.hostname);
  if (kind && t.hostname !== p.hostname) return `${ARTICLE[kind]} ${kind} address other than the page's own host`;
  const s = server ? parse(server) : null;
  if (s && isServer(t, s) && !isServer(p, s)) return `the page-archiver server (${s.origin}), not the page itself`;
  return null;
}
