import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../events";
import { isPersisted, parseLog, serializeLine, SESSION_FORMAT, type ParsedLog, type SessionHeader, type SessionRecord } from "./format";

export const SESSION_FILE = "session.cairn.jsonl";

export function sessionDir(root: string, sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error(`invalid session id: ${sessionId}`);
  return path.join(root, sessionId);
}

export async function readSession(root: string, sessionId: string): Promise<ParsedLog | undefined> {
  try {
    return parseLog(await readFile(path.join(sessionDir(root, sessionId), SESSION_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function listSessions(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface SessionWriter {
  readonly header: SessionHeader;
  /** Appends in order; resolves once the line is on disk. Non-persisted events are no-ops. */
  append(event: AgentEvent): Promise<SessionRecord | undefined>;
}

/** Create a new log, or reopen an existing one and continue its sequence. */
export async function openSession(
  root: string,
  init: { id: string; cwd?: string; parentId?: string; origin?: SessionHeader["origin"] },
  now: () => number = Date.now,
): Promise<{ writer: SessionWriter; existing?: ParsedLog }> {
  const dir = sessionDir(root, init.id);
  const file = path.join(dir, SESSION_FILE);
  const existing = await readSession(root, init.id);
  let header: SessionHeader;
  let seq = 0;
  if (existing) {
    header = existing.header;
    seq = existing.records.at(-1)?.seq ?? 0;
    // A torn tail would glue the next record onto a partial line; rewrite clean.
    if (existing.skipped) await writeFile(file, serializeLine(header) + existing.records.map(serializeLine).join(""));
  } else {
    header = { type: "session", version: SESSION_FORMAT, id: init.id, cwd: init.cwd, createdAt: now(), parentId: init.parentId, origin: init.origin ?? "native" };
    await mkdir(dir, { recursive: true });
    await writeFile(file, serializeLine(header));
  }
  // Serialize appends so concurrent callers keep seq order on disk.
  let tail: Promise<unknown> = Promise.resolve();
  const writer: SessionWriter = {
    header,
    append(event) {
      if (!isPersisted(event)) return Promise.resolve(undefined);
      const record: SessionRecord = { seq: ++seq, time: now(), event };
      const run = tail.then(() => appendFile(file, serializeLine(record)));
      tail = run.catch(() => undefined);
      return run.then(() => record);
    },
  };
  return { writer, existing };
}

/** Write a complete log in one atomic step (temp file + rename). Used by importers; refuses to overwrite. */
export async function writeImportedSession(root: string, header: SessionHeader, records: readonly SessionRecord[]): Promise<boolean> {
  const dir = sessionDir(root, header.id);
  const file = path.join(dir, SESSION_FILE);
  if (await readSession(root, header.id)) return false;
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serializeLine(header) + records.map(serializeLine).join(""));
  await rename(tmp, file);
  return true;
}
