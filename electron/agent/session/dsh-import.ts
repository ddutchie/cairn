/**
 * One-way importer for dsh session logs (format v0–v4) → cairn-session/1.
 * Reads the JSONL structurally — no dsh packages — so it keeps working after
 * they are removed. Lossless for the conversation (user text, assistant
 * text/thinking/tool calls with signatures, tool results, usage, title);
 * dsh-internal bookkeeping (steps, request headers, prunes, presets) is
 * dropped. Source files are never modified.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { AgentEvent, TurnEndReason } from "../events";
import { SESSION_FORMAT, type SessionHeader, type SessionRecord } from "./format";
import { readSession, writeImportedSession } from "./log";

const zstd = promisify(zstdDecompress);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface ImportReport {
  records: number;
  turns: number;
  /** Image parts replaced by a text placeholder (the new event model carries text only). */
  imagesDropped: number;
  /** Compaction/prune events seen; the full original history is kept either way. */
  compactions: number;
  /** Event lines we could not parse or understand. */
  skipped: number;
}

export interface ImportedSession {
  header: SessionHeader;
  records: SessionRecord[];
  report: ImportReport;
}

function textOf(parts: unknown, report?: ImportReport): string {
  return arr(parts).map((p) => {
    const part = obj(p);
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "image" || part.type === "image-url") { if (report) report.imagesDropped++; return "[image omitted]"; }
    return "";
  }).join("");
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Obj;
  if (typeof raw !== "string") return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v as Obj : {}; } catch { return {}; }
}

function stopReason(kind: string | undefined): StopReason {
  if (kind === "toolUse" || kind === "tool-calls" || kind === "tool_calls") return "toolUse";
  if (kind === "length" || kind === "max-tokens") return "length";
  if (kind === "aborted" || kind === "cancelled") return "aborted";
  if (kind === "error") return "error";
  return "stop";
}

function turnEnd(reason: unknown): TurnEndReason {
  const kind = str(obj(reason).kind) ?? str(reason);
  switch (kind) {
    case "aborted": case "cancelled": case "interrupted": return "aborted";
    case "error": case "failed": return "error";
    case "max-steps": case "max_steps": return "max-steps";
    default: return "stop";
  }
}

function assistantMessage(data: Obj, time: number): AssistantMessage {
  const message = obj(data.message);
  const source = obj(message.source);
  const replay = obj(source.replayState);
  const response = obj(replay.response);
  const blocks = arr(replay.blocks).map(obj);
  const content: AssistantMessage["content"] = [];
  arr(message.content).forEach((raw, i) => {
    const p = obj(raw);
    if (p.type === "text" && typeof p.text === "string") content.push({ type: "text", text: p.text });
    else if (p.type === "reasoning" && typeof p.text === "string") {
      const sig = str(blocks[i]?.thinkingSignature);
      content.push({ type: "thinking", thinking: p.text, ...(sig ? { thinkingSignature: sig } : {}) });
    } else if (p.type === "tool-call") {
      content.push({ type: "toolCall", id: String(p.id ?? ""), name: String(p.name ?? ""), arguments: parseArgs(p.arguments) as never });
    }
  });
  const u = obj(data.usage);
  const input = num(u.inputTokens), output = num(u.outputTokens), cacheRead = num(u.cacheReadTokens), cacheWrite = num(u.cacheCreationTokens ?? u.cacheWriteTokens);
  return {
    role: "assistant",
    content,
    api: (str(response.api) ?? "openai-completions") as AssistantMessage["api"],
    provider: str(source.provider) ?? str(response.provider) ?? "imported",
    model: str(source.model) ?? str(response.model) ?? "unknown",
    ...(str(response.responseId) ? { responseId: str(response.responseId) } : {}),
    usage: {
      input, output, cacheRead, cacheWrite,
      ...(num(u.reasoningTokens) ? { reasoning: num(u.reasoningTokens) } : {}),
      totalTokens: num(u.totalTokens) || input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: stopReason(str(response.stopReason) ?? (content.some((c) => c.type === "toolCall") ? "toolUse" : "stop")),
    timestamp: time,
  };
}

function toolResult(data: Obj): { callId: string; text: string; isError: boolean } {
  const message = obj(data.message);
  const callId = str(data.callId) ?? str(message.toolCallId) ?? str(obj(message.source).callId) ?? "";
  // v4: role "tool", content = output blocks. v0–v3: content[0] is a { type:"tool-result", content, isError } wrapper.
  const first = obj(arr(message.content)[0]);
  const wrapped = first.type === "tool-result";
  const text = typeof data.output === "string" ? data.output : textOf(wrapped ? first.content : message.content);
  const isError = message.isError === true || first.isError === true || typeof data.error === "string";
  return { callId, text: typeof data.error === "string" ? data.error : text, isError };
}

/** Parse the text of a decompressed dsh session log. Returns undefined if it is not one. */
export function importDshLog(text: string): ImportedSession | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  const report: ImportReport = { records: 0, turns: 0, imagesDropped: 0, compactions: 0, skipped: 0 };
  let head: Obj | undefined;
  let title: string | undefined;
  const toolNames = new Map<string, string>();
  const records: SessionRecord[] = [];
  let seq = 0;
  let sessionId = "";
  const push = (time: number, event: AgentEvent) => { records.push({ seq: ++seq, time, event }); };

  for (const line of lines) {
    let e: Obj;
    try { e = JSON.parse(line) as Obj; } catch { report.skipped++; continue; }
    if (!head) {
      if (e.type !== "session" || typeof e.id !== "string") return undefined;
      head = e; sessionId = e.id; continue;
    }
    const data = obj(e.data);
    const time = num(e.time);
    switch (e.type) {
      case "turn/start":
        report.turns++;
        push(time, { type: "turn/start", sessionId, profile: "imported" });
        break;
      case "user/message": {
        // Injected instruction/runtime snapshots are rebuilt by the new engine; keep only what the human sent.
        const kind = str(obj(data.source).kind);
        if (kind && kind !== "user") break;
        push(time, { type: "user/message", content: textOf(data.content, report) });
        break;
      }
      case "assistant/message": {
        const message = assistantMessage(data, time);
        push(time, { type: "assistant/message", message });
        break;
      }
      case "tool/call": {
        const callId = String(data.callId ?? "");
        const name = String(data.name ?? "tool");
        toolNames.set(callId, name);
        // Historical record only — risk is not consulted when replaying.
        push(time, { type: "tool/call", callId, name, args: parseArgs(data.arguments ?? data.args) as never, risk: "READ" });
        break;
      }
      case "tool/result": {
        const r = toolResult(data);
        push(time, { type: "tool/result", callId: r.callId, name: String(data.name ?? toolNames.get(r.callId) ?? "tool"), text: r.text, isError: r.isError });
        break;
      }
      case "turn/end":
        push(time, { type: "turn/end", reason: turnEnd(data.reason) });
        break;
      case "session/title": {
        const t = str(data.title);
        if (t) title = t;
        break;
      }
      case "compaction/prune": case "compaction/summary": case "compaction/end":
        report.compactions++;
        break;
      default: break; // dsh bookkeeping
    }
  }
  if (!head) return undefined;
  report.records = records.length;
  const parent = str(head.parentSession) ?? str(obj(head.parent).id);
  return {
    header: {
      type: "session", version: SESSION_FORMAT, id: sessionId, cwd: str(head.cwd), createdAt: num(head.createdAt),
      ...(parent ? { parentId: parent } : {}), ...(title ? { title } : {}), origin: "dsh-import",
    },
    records,
    report,
  };
}

const LOG_NAMES = ["session.v4.jsonl.zstd", "session.jsonl.zstd", "session.v4.jsonl", "session.jsonl"];

export async function readDshLogFile(file: string): Promise<string> {
  const raw = await readFile(file);
  return file.endsWith(".zstd") ? (await zstd(raw)).toString("utf8") : raw.toString("utf8");
}

export interface ImportSummary {
  imported: string[];
  /** Already present in the destination — left alone. */
  existing: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Import every session under a dsh `sessions/<projectKey>/<id>/` tree. Idempotent: a session
 * whose destination log already exists is skipped, so a half-finished run can simply be rerun.
 */
export async function importDshTree(dshRoot: string, cairnRoot: string): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: [], existing: [], failed: [] };
  let projects: string[];
  try { projects = (await readdir(dshRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return summary; }
  for (const project of projects) {
    const ids = (await readdir(path.join(dshRoot, project), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const id of ids) {
      const dir = path.join(dshRoot, project, id);
      try {
        const names = new Set(await readdir(dir));
        const name = LOG_NAMES.find((n) => names.has(n));
        if (!name) continue;
        if (await readSession(cairnRoot, id)) { summary.existing.push(id); continue; }
        const parsed = importDshLog(await readDshLogFile(path.join(dir, name)));
        if (!parsed) throw new Error("not a dsh session log");
        // The directory name is authoritative for the id the app already knows.
        parsed.header.id = id;
        await writeImportedSession(cairnRoot, parsed.header, parsed.records);
        summary.imported.push(id);
      } catch (err) {
        summary.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return summary;
}



/** Import one session by id from a dsh tree (any project folder). False when it is absent or already imported. */
export async function importDshSession(dshRoot: string, cairnRoot: string, sessionId: string): Promise<boolean> {
  if (await readSession(cairnRoot, sessionId)) return false;
  let projects: string[];
  try { projects = (await readdir(dshRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return false; }
  for (const project of projects) {
    const dir = path.join(dshRoot, project, sessionId);
    const names = await readdir(dir).catch(() => undefined);
    const name = names && LOG_NAMES.find((n) => names.includes(n));
    if (!name) continue;
    const parsed = importDshLog(await readDshLogFile(path.join(dir, name)));
    if (!parsed) return false;
    parsed.header.id = sessionId;
    return writeImportedSession(cairnRoot, parsed.header, parsed.records);
  }
  return false;
}
