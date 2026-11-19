/**
 * Keeps private persona notes out of agent reads (docs/plans/people-layer.md,
 * "Private from agents"). Every model-facing tool result passes through
 * `scrubAgentPrivate` in the consolidated dispatcher, so one place covers chat,
 * coding sessions and MCP, and a new read tool is covered without extra code.
 * `people-privacy.test.ts` walks every read tool to keep it that way. The
 * filtering itself is pure and lives in `shared/agent/people-privacy.ts`
 * (mobile uses it too); this file binds it to the desktop database.
 */
import type Database from "better-sqlite3";
import { agentHiddenNoteIds } from "../../db/people-queries";
import { findLiveNoteByTitle } from "../../db/notes-queries";
import { refusesHiddenNoteWrite, scrubHidden } from "../../../shared/agent/people-privacy";

/** Drop every reference to a hidden (agent-private) note from a tool result. */
export function scrubAgentPrivate(db: Database.Database, result: unknown, args: Record<string, unknown> = {}): unknown {
  return scrubHidden(agentHiddenNoteIds(db), result, args);
}

/**
 * Guard for agent WRITES: a call naming a hidden note (by id, or by the title
 * `ensure_note` would match) is refused before anything runs, so the model can
 * neither edit a persona note nor learn its id through a write result.
 */
export function refusesHiddenWrite(db: Database.Database, name: string, args: Record<string, unknown>): { error: string } | null {
  return refusesHiddenNoteWrite(agentHiddenNoteIds(db), name, args, (projectId, title) => findLiveNoteByTitle(db, projectId, title)?.id);
}
