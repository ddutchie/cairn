/**
 * Web search + extraction clients for the chat `web_search` / `web_extract`
 * tools. Runs on-device via expo/fetch (no vendor SDK), mirroring the direct
 * fetch pattern in models-dev.ts / providers/openai.ts.
 *
 * TAVILY-ONLY. Brave search now lives in the community registry as an HTTP
 * `service` (install it from Settings → AI → Tools & Services) — routed through
 * the generic service executor in services.ts. Keeping a second hardcoded Brave
 * client here would mean maintaining the SAME connector twice, so the built-in
 * path is Tavily's alone:
 *   - Tavily (https://api.tavily.com) — POST /search (Bearer auth) for
 *     `web_search`, POST /extract for `web_extract` (page reading).
 *
 * These built-in tools are slated for full removal in Track 3, once the mobile
 * MCP client + a registry Tavily connector land and EVERYTHING is registry-
 * driven. Until then they remain the Tavily path so mobile never loses search
 * or page extraction (the registry has no Tavily entry yet).
 *
 * Results are deliberately COMPACT (title + url + short snippet, capped count):
 * tool outputs are serialised into the model context via JSON.stringify in the
 * agent loop, and the Apple on-device path has a ~4K-token window — returning
 * full page bodies would blow the budget. `web_extract` is the opt-in path for
 * reading a full page, and even it trims to a character cap.
 */

import { fetch as expoFetch } from "expo/fetch";
import { getTavilyApiKey } from "./web-config";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Hard cap on results returned to the model (keeps tool output compact). */
const MAX_RESULTS = 5;
/** Hard cap on extracted page content length (chars) to protect the context. */
const EXTRACT_CHAR_CAP = 8000;

/** A single normalised search hit, provider-agnostic. */
interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Clamp a user-supplied count into [1, MAX_RESULTS]. */
function clampCount(v: unknown): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return MAX_RESULTS;
  return Math.min(n, MAX_RESULTS);
}

/** Trim + collapse whitespace and cap length so snippets stay compact. */
function trimSnippet(s: unknown, cap = 500): string {
  const text = (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** Pull a human-readable error message out of a provider's JSON error body. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      detail?: { error?: string } | string;
      message?: string;
      error?: string;
    };
    const detail =
      typeof body.detail === "object" ? body.detail?.error : body.detail;
    return detail || body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

/** Tavily POST /search → normalised hits. */
async function tavilySearch(
  apiKey: string,
  query: string,
  count: number,
): Promise<WebSearchHit[]> {
  const res = await expoFetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      chunks_per_source: 3,
      max_results: count,
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Tavily search failed (${res.status})`));
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? []).map((r) => ({
    title: trimSnippet(r.title, 200),
    url: typeof r.url === "string" ? r.url : "",
    snippet: trimSnippet(r.content),
  }));
}

/** Brave GET /res/v1/web/search → normalised hits.
 * REMOVED — Brave is now a community-registry HTTP service (services.ts). */

/**
 * Run a web search via Tavily. Returns compact hits or an { error } object the
 * model can read and relay to the user (missing key, quota, network). Never
 * throws. Brave search is available separately as an installed registry service.
 */
export async function webSearch(query: string, count?: number): Promise<
  { provider: "tavily"; results: WebSearchHit[] } | { error: string }
> {
  const q = query.trim();
  if (!q) return { error: "Empty search query." };
  const apiKey = await getTavilyApiKey();
  if (!apiKey) {
    return {
      error: "No Tavily API key is set. Add one in Settings → AI → Web search, or install Brave Search from Tools & Services.",
    };
  }
  const n = clampCount(count);
  try {
    const results = await tavilySearch(apiKey, q, n);
    return { provider: "tavily", results };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Extract the clean text/markdown of a web page. Tavily-only (Brave has no
 * extraction endpoint), so this uses a Tavily key regardless of the active
 * search provider — if only a Brave key is set, it returns a helpful error.
 * Content is capped to protect the model context. Never throws.
 */
export async function webExtract(url: string): Promise<
  { url: string; content: string } | { error: string }
> {
  const target = url.trim();
  if (!target) return { error: "Empty URL." };
  const apiKey = await getTavilyApiKey();
  if (!apiKey) {
    return {
      error:
        "Reading a page needs a Tavily API key (Brave doesn't support extraction). Add one in Settings → AI → Web search.",
    };
  }
  try {
    const res = await expoFetch(TAVILY_EXTRACT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ urls: target, extract_depth: "basic", format: "markdown" }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, `Tavily extract failed (${res.status})`));
    const data = (await res.json()) as {
      results?: { url?: string; raw_content?: string }[];
      failed_results?: { url?: string; error?: string }[];
    };
    const hit = data.results?.[0];
    if (!hit?.raw_content) {
      const failed = data.failed_results?.[0]?.error;
      return { error: failed || "Couldn't extract content from that URL." };
    }
    const content = hit.raw_content;
    return {
      url: hit.url || target,
      content:
        content.length > EXTRACT_CHAR_CAP
          ? `${content.slice(0, EXTRACT_CHAR_CAP)}\n\n[…truncated]`
          : content,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
