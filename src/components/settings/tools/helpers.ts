/**
 * Pure helpers + shared class constants for the Tools settings panel, extracted
 * from ToolsSettings.tsx so the form/list sub-components can share them without
 * the monolithic parent. No React here — the credential heuristics are
 * unit-testable in isolation.
 */

export interface HeaderRow {
  name: string;
  value: string;
  isSecret: boolean;
}

const PLACEHOLDER_RE = /<API_KEY>|YOUR_API_KEY|<ACCESS_TOKEN>|<TOKEN>/;

/** Whether a header value is a secret placeholder or an existing secret:// ref. */
export function looksSecret(value: string): boolean {
  return PLACEHOLDER_RE.test(value) || value.startsWith("secret://");
}

/**
 * Heuristic for "this header value is a credential" — used so a token typed
 * into a normal-looking header is still stored in the keychain rather than
 * persisted as plaintext config.
 */
export function looksLikeCredential(name: string, value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("secret://")) return false;
  const n = name.toLowerCase();
  if (n === "authorization" || /api[_-]?key|token|secret|access[_-]?key/.test(n)) return true;
  if (/^bearer\s+\S/i.test(value)) return true;
  return false;
}

export function headersToRows(headers?: Record<string, string>): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    name,
    value,
    isSecret: looksSecret(value),
  }));
}

export const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none";
export const labelCls =
  "text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1";
