/**
 * Shared DB utilities for the Electron main process.
 * Imported by chat.ts, handlers.ts, and mcp-server.ts to avoid duplication.
 */

import { nanoid } from "nanoid";

/** Generate a 12-character random ID (nanoid, ~71 bits of entropy). */
export function newId(): string {
  return nanoid(12);
}

/** Current timestamp as ISO 8601 string. */
export function ts(): string {
  return new Date().toISOString();
}
