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

/**
 * Fetch and parse a URL's metadata. Throws Error on invalid URL, non-http(s)
 * protocol, non-2xx response, or fetch failure.
 */
export async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  // Basic URL validation
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are supported");
  }

  const response = await net.fetch(url, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
