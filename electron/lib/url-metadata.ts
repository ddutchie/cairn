/**
 * URL metadata fetcher (OG tags + <title>).
 *
 * Runs in the Electron main process (so it has no CORS restrictions) and
 * extracts the same metadata a social-media link unfurls would.
 *
 * Used by the `db:flow:url:fetch` IPC handler (in `electron/ipc/url-metadata.ts`)
 * for the `create_idea_flow_node` URL-node creation flow — fetching title +
 * description so the user can confirm the node is what they intended.
 */

import { net } from "electron";

export interface UrlMetadata {
  title: string;
  description: string;
}

const USER_AGENT = "Mozilla/5.0 (compatible; Cairn/1.0)";
/** Only read up to ~50 KB of the response — enough to capture the <head>. */
const RESPONSE_BYTE_LIMIT = 50_000;
/** Abort the whole fetch if the server is too slow to send the head. */
const FETCH_TIMEOUT_MS = 8_000;
/** Limit how many redirects we are willing to follow. */
const MAX_REDIRECTS = 5;

/**
 * Reject non-public hosts (localhost, private ranges, link-local) to mitigate
 * SSRF when fetching arbitrary URLs supplied by the user.
 */
function assertPublicHost(hostname: string): void {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower === "::1") {
    throw new Error("Non-public host");
  }

  // IPv4 loopback, private ranges, and link-local.
  const ipv4 = lower.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) {
    const [a, b] = ipv4.map(Number);
    if (a === 127 || a === 10) throw new Error("Non-public host");
    if (a === 172 && b >= 16 && b <= 31) throw new Error("Non-public host");
    if (a === 192 && b === 168) throw new Error("Non-public host");
    if (a === 169 && b === 254) throw new Error("Non-public host");
  }

  // IPv6 link-local.
  if (lower.startsWith("fe80:")) throw new Error("Non-public host");
}

async function fetchWithHostValidation(url: string, redirectCount = 0): Promise<Response> {
  if (redirectCount > MAX_REDIRECTS) throw new Error("Too many redirects");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are supported");
  }
  assertPublicHost(parsed.hostname);

  const response = await net.fetch(url, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "manual",
  });

  // 3xx redirect: validate the new host before following it.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect missing Location header");
    const nextUrl = new URL(location, url).toString();
    return fetchWithHostValidation(nextUrl, redirectCount + 1);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return response;
}

/**
 * Fetch and parse a URL's metadata. Throws Error on invalid URL, non-http(s)
 * protocol, non-2xx response, non-public host, or fetch failure.
 */
export async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  const response = await fetchWithHostValidation(url);

  const parsed = new URL(response.url || url);

  const reader = response.body?.getReader();
  let html = "";
  let bytesRead = 0;
  if (reader) {
    while (bytesRead < RESPONSE_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytesRead += value.byteLength;
      // Stop once we have the closing </head> or enough bytes
      if (html.includes("</head>") || html.includes("</title>")) break;
    }
    reader.cancel();
  }

  // Extract OG title → plain title → hostname fallback
  // Two regex variants per OG meta: `property` before/after `content` to handle
  // different tag-ordering conventions.
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1]
    ?? html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
  const htmlTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];

  return {
    title: (ogTitle ?? htmlTitle ?? parsed.hostname ?? "").trim().slice(0, 200),
    description: (ogDesc ?? "").trim().slice(0, 500),
  };
}
