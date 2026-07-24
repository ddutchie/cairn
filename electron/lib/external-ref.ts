/**
 * External-reference extraction for MCP-server / custom-HTTP-service tool
 * results.
 *
 * Native Cairn tools (create_note, update_task, …) return a well-known shape, so
 * the chat loop can attach a `cairnRef` that renders a clickable chip opening the
 * note/task in-app. MCP and custom-service tools instead return arbitrary,
 * vendor-specific JSON — but the useful artefact is almost always an external
 * URL (a Confluence page, a Jira issue, a web-search hit, a GitHub PR, …).
 *
 * {@link extractExternalRef} is a best-effort, schema-less heuristic: it scans a
 * tool's stringified output for the most linkable thing and returns a normalized
 * `{ url, title?, snippet? }` the renderer can show as a browser-opening chip.
 * It is intentionally conservative — only http(s) URLs are ever returned, and it
 * gives up (returns undefined) rather than guess wildly, so the UI simply falls
 * back to the plain "✓ ToolName" chip.
 *
 * Pure + dependency-free → unit-testable in plain Node.
 */

export interface ExternalRef {
  url: string;
  title?: string;
  snippet?: string;
}

/**
 * URL-bearing field names, in priority order. `html_url`/`webUrl`/`permalink`
 * are the canonical "human" links on GitHub/Graph/Reddit etc.; a bare `url`/
 * `link`/`href` is the common fallback. `self` (Jira/Atlassian REST) is last
 * because it is often an API URL rather than a browser one — still better than
 * nothing when it is the only link present.
 */
const URL_KEYS = [
  "html_url",
  "webUrl",
  "web_url",
  "permalink",
  "browseUrl",
  "browse_url",
  "url",
  "link",
  "href",
  "self",
] as const;

/** Title-bearing field names, in priority order. */
const TITLE_KEYS = ["title", "name", "subject", "summary", "headline", "displayName"] as const;

/** Snippet/description field names, in priority order. */
const SNIPPET_KEYS = ["snippet", "description", "excerpt", "abstract", "text", "content"] as const;

/** Nested containers commonly holding a list of result objects. */
const LIST_KEYS = ["results", "items", "data", "hits", "matches", "records", "value", "entries"] as const;

/** Max depth to walk when hunting for a URL, to bound cost on huge payloads. */
const MAX_DEPTH = 6;

/**
 * Extract a single best external reference from a tool's stringified output.
 * Returns undefined when the output isn't JSON, holds no usable http(s) URL, or
 * is a Cairn error object.
 */
export function extractExternalRef(output: string | undefined): ExternalRef | undefined {
  if (!output || typeof output !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Non-JSON output (plain text). Fall back to the first bare https URL in it.
    return refFromLooseText(output);
  }
  // A Cairn tool error object ({ error: "…" }) carries nothing linkable.
  if (isPlainObject(parsed) && typeof parsed.error === "string" && Object.keys(parsed).length === 1) {
    return undefined;
  }
  return findRef(parsed, 0);
}

/**
 * Extract up to `max` external references from a list-shaped result (e.g. a web
 * search returning many hits), so the UI can render a compact stack. Falls back
 * to the single {@link extractExternalRef} when the payload isn't a list.
 */
export function extractExternalRefs(output: string | undefined, max = 3): ExternalRef[] {
  if (!output) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    const one = refFromLooseText(output);
    return one ? [one] : [];
  }
  const list = findList(parsed, 0);
  if (list && list.length > 0) {
    const refs: ExternalRef[] = [];
    for (const item of list) {
      const ref = findRef(item, 0);
      if (ref && !refs.some((r) => r.url === ref.url)) refs.push(ref);
      if (refs.length >= max) break;
    }
    if (refs.length > 0) return refs;
  }
  const single = findRef(parsed, 0);
  return single ? [single] : [];
}

// ── internals ────────────────────────────────────────────────────────────────

/** Depth-first search for the first usable URL, preferring shallow/priority keys. */
function findRef(value: unknown, depth: number): ExternalRef | undefined {
  if (depth > MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = findRef(item, depth + 1);
      if (ref) return ref;
    }
    return undefined;
  }

  if (!isPlainObject(value)) return undefined;

  // 1. A direct URL field on this object (priority order).
  const url = firstUrl(value);
  if (url) {
    return {
      url,
      title: firstString(value, TITLE_KEYS),
      snippet: trimSnippet(firstString(value, SNIPPET_KEYS)),
    };
  }

  // 2. Atlassian-style nested links: _links.webui / _links.self / links.html.
  // Prefer the human page keys (webui/html) over a generic self/api URL.
  const links = (value._links ?? value.links) as unknown;
  if (isPlainObject(links)) {
    const linkUrl = firstString(links, ["webui", "html"] as const) ?? firstUrl(links);
    if (linkUrl && isHttpUrl(linkUrl)) {
      return {
        url: linkUrl,
        title: firstString(value, TITLE_KEYS),
        snippet: trimSnippet(firstString(value, SNIPPET_KEYS)),
      };
    }
  }

  // 3. Recurse into nested objects/arrays (lists first — that's where hits live).
  for (const key of LIST_KEYS) {
    if (key in value) {
      const ref = findRef(value[key], depth + 1);
      if (ref) return ref;
    }
  }
  for (const v of Object.values(value)) {
    if (isPlainObject(v) || Array.isArray(v)) {
      const ref = findRef(v, depth + 1);
      if (ref) return ref;
    }
  }
  return undefined;
}

/** Find the first list of objects under a common container key. */
function findList(value: unknown, depth: number): unknown[] | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return undefined;
  for (const key of LIST_KEYS) {
    const v = value[key];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  for (const v of Object.values(value)) {
    if (isPlainObject(v)) {
      const nested = findList(v, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** First http(s) URL among the known URL keys of an object. */
function firstUrl(obj: Record<string, unknown>): string | undefined {
  for (const key of URL_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && isHttpUrl(v)) return v;
  }
  return undefined;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Only http(s) — never javascript:, data:, file:, etc. */
export function isHttpUrl(value: string): boolean {
  if (typeof value !== "string") return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:" || u.protocol === "http:";
}

const HTTPS_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/;
/** Pull the first bare http(s) URL out of a plain-text (non-JSON) tool result. */
function refFromLooseText(text: string): ExternalRef | undefined {
  const m = HTTPS_RE.exec(text);
  if (!m) return undefined;
  // Strip common trailing punctuation the regex may have swept up.
  const url = m[0].replace(/[.,;:]+$/, "");
  return isHttpUrl(url) ? { url } : undefined;
}

function trimSnippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const clean = s.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
