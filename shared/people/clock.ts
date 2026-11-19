/**
 * Ids and timestamps for People rows, usable on desktop (Electron main, MCP)
 * and mobile alike. Ids match the app-wide shape (12 chars of `A-Za-z0-9_-`,
 * the nanoid alphabet), drawn from the platform's crypto when it has one.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** A random 12-character row id. */
export function newId(): string {
  const bytes = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

/** Current time as an ISO 8601 string. */
export function ts(): string {
  return new Date().toISOString();
}
