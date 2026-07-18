/**
 * Web search + extraction clients for the chat `web_search` / `web_extract`
 * tools. Runs on-device via expo/fetch (no vendor SDK), mirroring the direct
 * fetch pattern in models-dev.ts / providers/openai.ts.
 *
 * Two search providers (see web-config.ts):
 *   - Tavily (https://api.tavily.com) — POST /search (Bearer auth). LLM-ready
 *     snippets. Also powers /extract for the `web_extract` tool.
 *   - Brave  (https://api.search.brave.com) — GET /res/v1/web/search
 *     (X-Subscription-Token header). Web index; search only.
 *
 * Results are deliberately COMPACT (title + url + short snippet, capped count):
 * tool outputs are serialised into the model context via JSON.stringify in the
 * agent loop, and the Apple on-device path has a ~4K-token window — returning
 * full page bodies would blow the budget. `web_extract` is the opt-in path for
 * reading a full page, and even it trims to a character cap.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  getWebProvider,
  getWebApiKey,
  getTavilyApiKey,
  type WebProvider,
} from "./web-config";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

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

/** Brave GET /res/v1/web/search → normalised hits. */
async function braveSearch(
  apiKey: string,
  query: string,
  count: number,
): Promise<WebSearchHit[]> {
  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await expoFetch(url, {
    method: "GET",
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Brave search failed (${res.status})`));
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: trimSnippet(r.title, 200),
    url: typeof r.url === "string" ? r.url : "",
    snippet: trimSnippet(r.description),
  }));
}

/**
 * Run a web search with the user's configured provider. Returns compact hits or
 * an { error } object the model can read and relay to the user (missing key,
 * quota, network). Never throws.
 */
export async function webSearch(query: string, count?: number): Promise<
  { provider: WebProvider; results: WebSearchHit[] } | { error: string }
> {
  const q = query.trim();
  if (!q) return { error: "Empty search query." };
  const provider = getWebProvider();
  const apiKey = await getWebApiKey(provider);
  if (!apiKey) {
    return {
      error: `No ${provider === "brave" ? "Brave" : "Tavily"} API key is set. Add one in Settings → AI → Web search.`,
    };
  }
  const n = clampCount(count);
  try {
    const results =
      provider === "brave"
        ? await braveSearch(apiKey, q, n)
        : await tavilySearch(apiKey, q, n);
    return { provider, results };
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
