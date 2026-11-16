/**
 * Local / private host classification shared by the main process and the renderer.
 *
 * Pure: no Node imports (no `node:net`), so it runs in Electron main,
 * the Next.js renderer, and the mobile app unchanged. Callers that need
 * DNS (notably `web_fetch`) resolve hostnames to IPs first and classify
 * the results — a bare DNS name classifies as "public" (see below).
 *
 * Two named predicates, two different decisions (Q3 — do not conflate):
 * - {@link isLoopbackHost} — "needs no key": the endpoint is this machine
 *   (localhost names, 127/8, ::1/::, 0.0.0.0). Used for key exemption
 *   (`isLocalEndpoint`, `isLocalBaseUrl`) and usage "Local" labelling input.
 * - {@link isPrivateAddress} — "must not fetch": the address is not a public
 *   routable IP. Fail-closed: loopback, private, link-local AND invalid all
 *   refuse. Used by SSRF guards (`web_fetch`, `url-metadata`).
 */

export type HostClass = "loopback" | "private" | "link-local" | "public" | "invalid";

/** Normalise a host for classification: lowercase, strip brackets and zone. */
function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct !== -1 && h.includes(":")) h = h.slice(0, pct);
  if (h.endsWith(".") && h.length > 1) h = h.slice(0, -1);
  return h;
}

function isValidIPv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255);
}

/** The 16-bit groups of an IPv6 address, or undefined when it is not one. */
function v6Groups(ip: string): number[] | undefined {
  if (!ip.includes(":")) return undefined;
  let text = ip;
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return undefined;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  // More than one `::` is not a valid address.
  if (text.split("::").length > 2) return undefined;
  // A bare `:` split must be all-hex; reject stray characters early so that
  // hostnames containing a colon (e.g. `host:port`) read as invalid, not public.
  if (!/^[0-9a-f:]+$/.test(text)) return undefined;
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (!text.includes("::") && left.length !== 8) return undefined;
  const fill = text.includes("::") ? new Array(Math.max(0, 8 - left.length - right.length)).fill("0") : [];
  const groups = [...left, ...fill, ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

function classifyIPv4(host: string): HostClass {
  const [a, b, c] = host.split(".").map(Number);
  if (a === 127 || host === "0.0.0.0") return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (
    a === 10 ||
    a === 0 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    return "private";
  }
  return "public";
}

function classifyIPv6(g: number[]): HostClass {
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // IPv4 carried inside IPv6, in either spelling (`::ffff:127.0.0.1` is
  // `::ffff:7f00:1`): mapped, compatible, NAT64.
  if ((zeros(5) && g[5] === 0xffff) || zeros(6) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
    if (zeros(6) && g[6] === 0 && g[7] <= 1) return "loopback"; // `::` and `::1`
    return classifyIPv4(embedded);
  }
  // Unique local (fc00::/7), link local (fe80::/10), multicast (ff00::/8).
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00) return "private";
  return "public";
}

/**
 * Classify a host string (IP literal, `localhost` name, or DNS name).
 *
 * - DNS names that are not `localhost` classify as "public": the caller is
 *   expected to resolve them (like `web_fetch` does) and classify each
 *   answered address. Unresolvable or garbage input classifies as "invalid".
 */
export function classifyHost(host: string): HostClass {
  const h = normaliseHost(host);
  if (!h) return "invalid";
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (h.includes(":")) {
    const g = v6Groups(h);
    return g ? classifyIPv6(g) : "invalid";
  }
  if (isValidIPv4(h)) return classifyIPv4(h);
  // Dotted numerics that are not valid IPv4 (`999.1.1.1`, `2130706433`)
  // are not DNS names — refuse rather than guess.
  if (/^[0-9.]+$/.test(h)) return "invalid";
  return "public";
}

/**
 * "Needs no key": true only for this-machine endpoints (localhost names,
 * 127/8, `::1`/`::`, `0.0.0.0`). LAN ranges are NOT loopback — a LAN
 * endpoint still needs its key; it just displays as local.
 */
export function isLoopbackHost(host: string): boolean {
  return classifyHost(host) === "loopback";
}

/**
 * "Must not fetch": fail-closed SSRF predicate over IP literals. Anything
 * that is not a public routable address — loopback, private, link-local,
 * or invalid — refuses. Pass resolved IPs (resolve DNS names first, as
 * `web_fetch` does); a bare DNS name reads as public by design.
 */
export function isPrivateAddress(ip: string): boolean {
  return classifyHost(ip) !== "public";
}

/**
 * True when a base URL points at this machine (key-exempt local endpoint).
 * Accepts a full URL or a bare `host[:port]` string.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    let urlString = baseUrl.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlString)) {
      urlString = "http://" + urlString;
    }
    return isLoopbackHost(new URL(urlString).hostname);
  } catch {
    return false;
  }
}
