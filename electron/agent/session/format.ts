/**
 * cairn-session/v1 — an append-only JSONL log of AgentEvents. Line 1 is the
 * header; every other line is a Record. Deltas are never stored, and pi-ai
 * AssistantMessages are kept verbatim so replay needs no translation.
 */
import type { AgentEvent } from "../events";

export const SESSION_FORMAT = "cairn-session/1";

export interface SessionHeader {
  type: "session";
  version: typeof SESSION_FORMAT;
  id: string;
  cwd?: string;
  createdAt: number;
  parentId?: string;
  title?: string;
  /** "native" for sessions written by this engine, "legacy-import" for converted ones. */
  origin: "native" | "legacy-import";
}

export interface SessionRecord {
  seq: number;
  time: number;
  event: AgentEvent;
}

/** Events that are display-only and not worth persisting. */
export function isPersisted(event: AgentEvent): boolean {
  return event.type !== "assistant/delta" && event.type !== "assistant/thinking";
}

export function serializeLine(value: SessionHeader | SessionRecord): string {
  return `${JSON.stringify(value)}\n`;
}

export interface ParsedLog {
  header: SessionHeader;
  records: SessionRecord[];
  /** Lines that failed to parse (a torn final line is expected after a crash). */
  skipped: number;
}

/** Parse a log; a truncated or corrupt line is skipped, never fatal. Returns undefined without a valid header. */
export function parseLog(text: string): ParsedLog | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  let header: SessionHeader | undefined;
  const records: SessionRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { skipped++; continue; }
    const v = value as { type?: unknown; version?: unknown; event?: unknown; seq?: unknown };
    if (!header) {
      if (v.type === "session" && v.version === SESSION_FORMAT) { header = value as SessionHeader; continue; }
      return undefined;
    }
    if (typeof v.seq === "number" && v.event && typeof v.event === "object") records.push(value as SessionRecord);
    else skipped++;
  }
  return header ? { header, records, skipped } : undefined;
}
