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

/** Tool kinds that own secrets. Mirrors ToolType in src/types. */
export type ToolKind = "mcp" | "service";

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
    return safeStorage.decryptString(Buffer.from(cipher, "base64"));
  } catch {
    console.error("[secure-store] failed to decrypt secret ref");
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
    } else if (isPlaceholder(value) || containsPlaceholder(value)) {
      // An unfilled placeholder (e.g. "<API_KEY>" or "Bearer <API_KEY>") is a
      // missing secret, not a literal — drop it rather than send it verbatim.
    } else {
      out[name] = value;
    }
  }
  return out;
}
