/**
 * Fork: a new session that starts with a copy of another session's log.
 *
 * The copy is the conversation, not the source's standing state. A goal, reminders and (when the
 * fork is a different kind of session) approval rules belong to the session that set them, so they
 * are left behind. Subagent logs are not copied either: the fork keeps what the parent was told.
 */
import { SESSION_FORMAT, type SessionHeader, type SessionRecord } from "./format";
import { readSession, writeImportedSession } from "./log";

export interface ForkOptions {
  from: string;
  to: string;
  /** Working directory of the new session; defaults to the source's. */
  cwd?: string;
  /** Carry approval rules over. Only right when the fork is the same kind of session. */
  keepRules: boolean;
}

export function forkRecords(records: readonly SessionRecord[], opts: Pick<ForkOptions, "keepRules">): SessionRecord[] {
  return records.filter(({ event }) => {
    if (event.type === "goal/changed" || event.type === "schedule/changed") return false;
    if (event.type === "rule/added") return opts.keepRules;
    return true;
  });
}

/** Write the fork's log. Returns the number of records copied; throws when there is nothing to fork or the target exists. */
export async function forkSessionLog(root: string, opts: ForkOptions, now: () => number = Date.now): Promise<number> {
  const source = await readSession(root, opts.from);
  if (!source?.records.length) throw new Error("There is nothing to fork yet: the session has no messages.");
  const records = forkRecords(source.records, opts);
  const header: SessionHeader = { type: "session", version: SESSION_FORMAT, id: opts.to, cwd: opts.cwd ?? source.header.cwd, createdAt: now(), forkedFrom: opts.from, origin: "native" };
  if (!(await writeImportedSession(root, header, records))) throw new Error(`Session ${opts.to} already exists.`);
  return records.length;
}
