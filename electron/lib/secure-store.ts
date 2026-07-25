/**
 * Secure secret store — OS-keychain-backed credential storage for external tools.
 *
 * External tools (MCP servers, custom HTTP services) need to send secret header
 * values (API keys, bearer tokens). We NEVER persist those in cairn.db or in the
 * Zustand store. Instead:
 *
 *   - The tool config stores a *reference token* in its headers map:
 *         "Authorization": "secret://<toolId>/Authorization"
 *   - The real value lives here, encrypted with Electron `safeStorage`
 *     (Keychain on macOS, libsecret/DPAPI on Linux/Windows) and persisted as
 *     ciphertext to `userData/secrets.enc.json`.
 *
 * The renderer can only ever learn whether a secret is *set* (`secrets:has`) —
 * there is intentionally NO `secrets:get` IPC. Decryption happens exclusively in
 * the main process at tool-execution time via {@link resolveSecrets}.
 *
 * On platforms where encryption is unavailable (some headless Linux), set/has/
 * delete degrade gracefully: writes throw a clear error and `isAvailable()`
 * returns false so the UI can warn instead of silently storing plaintext.
 */

import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

const SECRETS_FILE = "secrets.enc.json";

/** Reference-token scheme. A header value of this shape is resolved at runtime. */
const SECRET_REF_PREFIX = "secret://";

/** On-disk shape: ref-token -> base64 ciphertext. */
type SecretStore = Record<string, string>;

// ── Pure helpers (unit-testable, no Electron) ────────────────────────────────

/**
 * Tool kinds that own secrets. Mirrors ToolType in src/types, plus "llm" for
 * the built-in AI provider API keys (the OpenAI-compatible chat/agent endpoints).
 */
export type ToolKind = "mcp" | "service" | "llm";

/**
 * Build the canonical reference token for a tool's named secret. The toolType is
 * part of the key so an MCP server and a custom service that happen to share an
 * id can never read, overwrite, or delete each other's secrets.
 */
export function secretRef(toolType: ToolKind, toolId: string, key: string): string {
  return `${SECRET_REF_PREFIX}${toolType}:${toolId}/${key}`;
}

/** True if a string is a secret reference token (not a literal value). */
export function isSecretRef(value: string): boolean {
  return typeof value === "string" && value.startsWith(SECRET_REF_PREFIX);
}

/** Matches a ref token embedded anywhere in a value (e.g. after a "Bearer " scheme). */
const EMBEDDED_REF_RE = new RegExp(`${SECRET_REF_PREFIX}\\S+`, "g");

/** True if a value contains a ref token but is not itself a bare ref. */
function containsSecretRef(value: string): boolean {
  return typeof value === "string" && !isSecretRef(value) && value.includes(SECRET_REF_PREFIX);
}

/** All reference tokens belonging to a given tool (used for orphan cleanup). */
export function refsForTool(store: SecretStore, toolType: ToolKind, toolId: string): string[] {
  const prefix = `${SECRET_REF_PREFIX}${toolType}:${toolId}/`;
  return Object.keys(store).filter((ref) => ref.startsWith(prefix));
}

/**
 * Known secret placeholder tokens used by community manifests / the AI builder.
 * A header whose value matches one of these is treated as "needs a real secret"
 * rather than a literal to send over the wire.
 */
const PLACEHOLDER_TOKENS = new Set([
  "<API_KEY>",
  "YOUR_API_KEY",
  "<ACCESS_TOKEN>",
  "<TOKEN>",
]);

/** True if a header value is an unfilled secret placeholder. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_TOKENS.has((value ?? "").trim());
}

/** True if a value contains a placeholder token anywhere (e.g. "Bearer <API_KEY>"). */
const PLACEHOLDER_RE = /<API_KEY>|YOUR_API_KEY|<ACCESS_TOKEN>|<TOKEN>/;
export function containsPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value ?? "");
}

// ── Persistence (Electron safeStorage) ───────────────────────────────────────

function getSecretsPath(): string {
  if (!app || !app.isReady()) return "";
  return path.join(app.getPath("userData"), SECRETS_FILE);
}

function readStore(): SecretStore {
  const filePath = getSecretsPath();
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SecretStore;
  } catch {
    // Corrupt store — treat as empty rather than crash. The user will be
    // prompted to re-enter credentials.
    console.error("[secure-store] secrets file unreadable; treating as empty");
    return {};
  }
}

function writeStore(store: SecretStore): void {
  const filePath = getSecretsPath();
  if (!filePath) throw new Error("Secure store unavailable: app not ready");
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

/** Whether OS-backed encryption is usable on this machine. */
export function isAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Store a secret value. The caller passes the explicit toolId + key; we return
 * the reference token that should be persisted in the tool config's headers.
 * Throws if encryption is unavailable (never silently stores plaintext).
 */
export function setSecret(toolType: ToolKind, toolId: string, key: string, value: string): string {
  if (!isAvailable()) {
    throw new Error(
      "Secret storage is unavailable on this system (OS keychain/encryption not accessible). Cannot store credentials securely."
    );
  }
  // Refuse to encrypt an unfilled placeholder (e.g. "<API_KEY>" or
  // "Bearer <API_KEY>"). Storing it would let the literal token reach the wire
  // later if it slipped past resolveSecrets. Treat it as "no secret provided".
  if (isPlaceholder(value) || containsPlaceholder(value)) {
    throw new Error("Refusing to store a placeholder secret value — enter a real credential.");
  }
  const ref = secretRef(toolType, toolId, key);
  const store = readStore();
  store[ref] = safeStorage.encryptString(value).toString("base64");
  writeStore(store);
  return ref;
}

/** True if a secret has been stored for this tool + key. No value is revealed. */
export function hasSecret(toolType: ToolKind, toolId: string, key: string): boolean {
  const ref = secretRef(toolType, toolId, key);
  return Object.prototype.hasOwnProperty.call(readStore(), ref);
}

/** Delete a single secret. No-op if absent. */
export function deleteSecret(toolType: ToolKind, toolId: string, key: string): void {
  const ref = secretRef(toolType, toolId, key);
  const store = readStore();
  if (Object.prototype.hasOwnProperty.call(store, ref)) {
    delete store[ref];
    writeStore(store);
  }
}

/** Delete every secret belonging to a tool. Used when a tool is removed. */
export function deleteToolSecrets(toolType: ToolKind, toolId: string): void {
  const store = readStore();
  const refs = refsForTool(store, toolType, toolId);
  if (refs.length === 0) return;
  for (const ref of refs) delete store[ref];
  writeStore(store);
}

/**
 * Decrypt the value behind a reference token. Main-process only. Returns null if
 * the ref is unknown or decryption fails. NEVER call from anything reachable by
 * the renderer.
 */
function getSecretByRef(ref: string): string | null {
  if (!isAvailable()) return null;
  const store = readStore();
  const cipher = store[ref];
  if (!cipher) return null;
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(cipher, "base64"));
    // Defensive: a placeholder must never round-trip out of the store, even if
    // an older build managed to persist one. Drop it rather than forward it.
    if (isPlaceholder(decrypted) || containsPlaceholder(decrypted)) return null;
    return decrypted;
  } catch {
    console.error("[secure-store] failed to decrypt secret ref");
    return null;
  }
}

/**
 * Replace every embedded ref token within a value with its decrypted value,
 * preserving surrounding text (e.g. "Bearer secret://…" → "Bearer <key>").
 * Returns null if any embedded ref fails to resolve, so the caller can drop the
 * header rather than transmit an unresolved "secret://…" token.
 */
function resolveEmbeddedRefs(value: string): string | null {
  let failed = false;
  const out = value.replace(EMBEDDED_REF_RE, (ref) => {
    const real = getSecretByRef(ref);
    if (real === null) {
      failed = true;
      return ref;
    }
    return real;
  });
  return failed ? null : out;
}

/**
 * Read the decrypted value behind a tool's named secret. Main-process only —
 * there is intentionally no renderer-facing equivalent. Returns null if unset
 * or undecryptable. Used by the OAuth provider to read token/client-info blobs.
 */
export function getSecretValue(toolType: ToolKind, toolId: string, key: string): string | null {
  return getSecretByRef(secretRef(toolType, toolId, key));
}

/**
 * Store a structured JSON blob (e.g. OAuth tokens or client registration) for a
 * tool. Unlike {@link setSecret}, this does NOT run placeholder validation — the
 * value is an opaque serialized object, not a header literal. Main-process only.
 */
export function setToolJson(toolType: ToolKind, toolId: string, key: string, value: unknown): void {
  if (!isAvailable()) {
    throw new Error(
      "Secret storage is unavailable on this system (OS keychain/encryption not accessible). Cannot store credentials securely."
    );
  }
  const ref = secretRef(toolType, toolId, key);
  const store = readStore();
  store[ref] = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
  writeStore(store);
}

/** Read and parse a JSON blob stored via {@link setToolJson}. Null if absent/invalid. */
export function getToolJson<T = unknown>(toolType: ToolKind, toolId: string, key: string): T | null {
  const raw = getSecretByRef(secretRef(toolType, toolId, key));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve a headers map for an outbound request: any value that is a secret
 * reference token is replaced with its decrypted value. Literal values pass
 * through untouched. Unresolved refs are dropped (header omitted) so we never
 * send the literal "secret://…" token over the wire.
 *
 * Main-process call site only (MCP client / service executor).
 */
export function resolveSecrets(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isSecretRef(value)) {
      const real = getSecretByRef(value);
      if (real !== null) out[name] = real;
      // else: drop the header rather than leak the ref token
    } else if (containsSecretRef(value)) {
      // Embedded ref with a surrounding scheme, e.g. "Bearer secret://…/Authorization".
      // Substitute the ref token in place, preserving the prefix. Drop the header
      // entirely if the ref can't be resolved so we never send the raw token.
      const resolved = resolveEmbeddedRefs(value);
      if (resolved !== null) out[name] = resolved;
    } else if (isPlaceholder(value) || containsPlaceholder(value)) {
      // An unfilled placeholder (e.g. "<API_KEY>" or "Bearer <API_KEY>") is a
      // missing secret, not a literal — drop it rather than send it verbatim.
    } else {
      out[name] = value;
    }
  }
  return out;
}

// ── LLM API keys ─────────────────────────────────────────────────────────────
//
// The built-in AI providers (chat + coding agent, one entry per saved provider)
// keep their API key here in the OS keychain instead of in the Zustand store,
// localStorage, or ai-settings-cache.json. The renderer only ever holds a
// reference token (`secret://llm:<providerId>/apiKey`); the raw key is resolved
// exclusively in the main process, at the IPC boundary, right before a request.

/** Canonical secret key under which every LLM provider stores its API key. */
export const LLM_API_KEY = "apiKey";

/** The reference token for a saved provider's API key. */
export function llmSecretRef(providerId: string): string {
  return secretRef("llm", providerId, LLM_API_KEY);
}

/**
 * Store a provider's raw API key in the keychain and return its reference token.
 * Empty/placeholder input clears any stored key and returns "" (meaning "no
 * key" — e.g. a keyless local server). Main-process only.
 */
export function setLlmApiKey(providerId: string, rawKey: string): string {
  const trimmed = (rawKey ?? "").trim();
  if (!trimmed || isPlaceholder(trimmed) || containsPlaceholder(trimmed)) {
    deleteSecret("llm", providerId, LLM_API_KEY);
    return "";
  }
  return setSecret("llm", providerId, LLM_API_KEY, trimmed);
}

/** Delete a provider's stored API key. No-op if absent. */
export function deleteLlmApiKey(providerId: string): void {
  deleteSecret("llm", providerId, LLM_API_KEY);
}

/**
 * Resolve an incoming `apiKey` config value to the real key for an outbound
 * request. Accepts either:
 *   - a `secret://llm:…/apiKey` reference token → decrypt from the keychain
 *   - any other non-empty string → treat as a literal key (already raw)
 *   - "" / undefined → "" (no key; keyless local endpoint)
 * Returns "" when a ref can't be resolved, so we never send the token on the wire.
 * Main-process only.
 */
export function resolveLlmApiKey(apiKey: string | undefined | null): string {
  const v = apiKey ?? "";
  if (!v) return "";
  if (isSecretRef(v)) return getSecretByRef(v) ?? "";
  // A literal key: guard against an unfilled placeholder ever reaching the wire,
  // mirroring setSecret/getSecretByRef.
  if (isPlaceholder(v) || containsPlaceholder(v)) return "";
  return v; // literal key
}
