/**
 * Cairn — app identity for provider attribution.
 *
 * Centralises the `User-Agent` product/version so the DSH harness
 * (dsh-llm) and Cairn's direct `fetch` paths send the same `cairn/<version>` string.
 * Version is read at runtime from the app's `package.json` via `app.getAppPath()` (Electron, dev + prod)
 * with a `process.cwd()` fallback for Vitest/standalone.
 */

import * as fs from "fs";
import * as path from "path";

function getCairnVersion(): string {
  try {
    // Electron main path — works in dev (app.getAppPath() → repo root) and prod (→ app.asar)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as { app?: { getAppPath?: () => string; getVersion?: () => string } };
    if (app?.getAppPath) {
      const pkgPath = path.join(app.getAppPath(), "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
    if (app?.getVersion) {
      const v = app.getVersion();
      if (v && v !== "0.0.0") return v;
    }
  } catch {
    // not in Electron, or app not ready yet
  }
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // ignore
  }
  return "3.0.1";
}

const version = getCairnVersion();

export const CAIRN_USER_AGENT = `cairn/${version}`;

export const CAIRN_APP_IDENTITY = {
  product: "cairn",
  version,
  url: "https://github.com/ddutchie/cairn",
} as const;

/** True when the base URL targets the OpenCode Zen proxy (opencode.ai). */
export function isOpencodeEndpoint(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("opencode.ai");
}

// ── Opencode session affinity ────────────────────────────────────────────
// Opencode's Zen proxy expects `x-opencode-session` (stable per conversation)
// for routing + prompt caching. The value is the DSH sessionId (`chat-<threadId>`
// for chat, the coding attempt id for coding) or a one-shot's opts.sessionId.

let currentOpencodeSessionId: string | null = null;

export function setCurrentOpencodeSessionId(id: string | null): void {
  currentOpencodeSessionId = id;
}

export function getCurrentOpencodeSessionId(): string | null {
  return currentOpencodeSessionId;
}

export function opencodeSessionHeaders(sessionId?: string | null): Record<string, string> {
  const id = sessionId ?? currentOpencodeSessionId;
  return id ? { "x-opencode-session": id } : {};
}

/** Build the full opencode-aware headers for a request (User-Agent + session). */
export function opencodeHeaders(baseUrl: string, sessionId?: string | null): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": CAIRN_USER_AGENT };
  if (isOpencodeEndpoint(baseUrl)) {
    const sess = opencodeSessionHeaders(sessionId);
    if (sess["x-opencode-session"]) headers["x-opencode-session"] = sess["x-opencode-session"];
  }
  return headers;
}

// Install a global fetch wrapper once so the DSH pi-ai path (which builds
// headers via `requestHeaders(profile.headers)` + `attributionHeaders()` and
// then calls `fetch`) also carries `x-opencode-session` + `User-Agent` for
// opencode endpoints without threading sessionId through pi-ai's static
// provider config. Direct callers (llm.ts, llm-transport.ts) also set the
// headers explicitly, so this is a safety net for any missed path.
// User-Agent is normalized to `cairn/<version>` (no URL comment) for all
// LLM requests; x-opencode-session is only added for opencode.ai.
if (!(globalThis as unknown as { __cairnFetchPatched?: boolean }).__cairnFetchPatched) {
  (globalThis as unknown as { __cairnFetchPatched?: boolean }).__cairnFetchPatched = true;
  const originalFetch = (globalThis.fetch as unknown as typeof fetch).bind(globalThis);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any, init?: any): Promise<any> => {
    try {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string })?.url;
      const isOpencode = typeof url === "string" && isOpencodeEndpoint(url);
      // Always normalize User-Agent to cairn/<version> for any fetch that
      // already carries a User-Agent (i.e. LLM provider calls). This
      // overwrites the DSH default `cairn/<version> (+url)` to the simpler
      // `cairn/<version>` the user requested, and also covers direct
      // callers that may have been built before this wrapper.
      const Hdr = (globalThis as unknown as { Headers?: new (init?: unknown) => { has: (k: string) => boolean; get: (k: string) => string | null; set: (k: string, v: string) => void } }).Headers;
      const headers = Hdr ? new Hdr(init?.headers as unknown) : null;
      if (headers) {
        const hasUA = headers.has("User-Agent");
        const currentUA = hasUA ? headers.get("User-Agent") : null;
        // Normalize any existing User-Agent that looks like cairn/... or
        // deepseek-harness/... to our simple form. Don't touch fetches with
        // no User-Agent (e.g. asset downloads) — they either set their own
        // (Cairn-Client/1.0 for llama) or use the runtime default.
        if (hasUA && currentUA !== CAIRN_USER_AGENT) {
          // Only normalize LLM-like UAs (cairn/ or deepseek-harness/) to avoid
          // clobbering unrelated fetches that set a custom UA.
          if (currentUA && (currentUA.startsWith("cairn/") || currentUA.startsWith("deepseek-harness/"))) {
            headers.set("User-Agent", CAIRN_USER_AGENT);
          }
        } else if (!hasUA && isOpencode) {
          // For opencode, always ensure a User-Agent even if none was set.
          headers.set("User-Agent", CAIRN_USER_AGENT);
        }
        if (isOpencode) {
          const sess = getCurrentOpencodeSessionId();
          if (sess && !headers.has("x-opencode-session")) headers.set("x-opencode-session", sess);
        }
        // Only create a new init if we mutated headers.
        if (headers.has("User-Agent") || headers.has("x-opencode-session")) {
          const newInit: Record<string, unknown> = { ...init, headers };
          return originalFetch(input as never, newInit as never);
        }
      } else {
        // Fallback when Headers ctor unavailable: mutate plain object.
        const plain = (init?.headers ?? {}) as Record<string, string>;
        const lower = Object.fromEntries(Object.entries(plain).map(([k, v]) => [k.toLowerCase(), v]));
        let mutated = false;
        if (lower["user-agent"] && (String(lower["user-agent"]).startsWith("cairn/") || String(lower["user-agent"]).startsWith("deepseek-harness/")) && lower["user-agent"] !== CAIRN_USER_AGENT.toLowerCase()) {
          (plain as Record<string, string>)["User-Agent"] = CAIRN_USER_AGENT;
          mutated = true;
        } else if (!lower["user-agent"] && isOpencode) {
          (plain as Record<string, string>)["User-Agent"] = CAIRN_USER_AGENT;
          mutated = true;
        }
        if (isOpencode && getCurrentOpencodeSessionId() && !lower["x-opencode-session"]) {
          (plain as Record<string, string>)["x-opencode-session"] = getCurrentOpencodeSessionId() as string;
          mutated = true;
        }
        if (mutated) return originalFetch(input as never, { ...init, headers: plain } as never);
      }
    } catch {
      // Never break a request on header injection failure.
    }
    return originalFetch(input as never, init as never);
  }) as unknown as typeof fetch;
}
