/**
 * Shared DB utilities for the Electron main process.
 * Imported by chat.ts, handlers.ts, and mcp-server.ts to avoid duplication.
 */

/** Generate a 12-character base-36 random ID. */
export function newId(): string {
  return Math.random().toString(36).slice(2, 14);
}

/** Current timestamp as ISO 8601 string. */
export function ts(): string {
  return new Date().toISOString();
}
