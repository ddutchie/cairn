/**
 * `get_today`: what the workspace's Today brief says, read-only.
 *
 * Shared by the chat/coding executor and the MCP server. Reads the saved files
 * through `lib/today-files.ts` (no connector or engine code, so the standalone
 * `cairn-mcp` binary can run it with the app closed) and cuts the brief down
 * with `todayDigest`.
 */

import type Database from "better-sqlite3";
import { todayDigest } from "../../../shared/today/digest";
import { getAutomationById, hasInFlightRun } from "../../db/automation-queries";
import { getProjects } from "../../db/workspace-queries";
import { findTodayAutomation, loadLatestTodayBrief, loadTodaySnapshot, readTodayMarks } from "../../lib/today-files";

export interface GetTodayArgs {
  date?: unknown;
  includeDone?: unknown;
  includeDrafts?: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The active workspace when the caller knows it; otherwise the first one with Today set up, else the first one. */
function todayWorkspace(db: Database.Database, activeWorkspaceId?: string): string | undefined {
  if (activeWorkspaceId) return activeWorkspaceId;
  const ids = (db.prepare("SELECT id FROM workspaces WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
  return ids.find((id) => findTodayAutomation(db, id)) ?? ids[0];
}

export function get_today(db: Database.Database, workspacePath: string, args: GetTodayArgs, activeWorkspaceId?: string): unknown {
  const date = typeof args.date === "string" && args.date.trim() ? args.date.trim() : undefined;
  if (date && !DATE.test(date)) return { error: "date must be YYYY-MM-DD." };
  const workspaceId = todayWorkspace(db, activeWorkspaceId);
  if (!workspaceId) return { error: "No workspace found." };

  const found = findTodayAutomation(db, workspaceId);
  const automation = found ? getAutomationById(db, found.id) ?? found : null;
  if (!automation) return { today: "off", message: "Today isn't set up for this workspace, so there's no brief. The user can turn it on in the Today view." };

  const saved = date
    ? loadTodaySnapshot(workspacePath, automation, date)
    : (() => { const b = loadLatestTodayBrief(workspacePath, automation); return b ? { brief: b, marks: readTodayMarks(workspacePath, automation, b.date) } : null; })();
  if (!saved) {
    if (date) return { today: automation.enabled ? "on" : "off", message: `There's no saved brief for ${date}. Briefs are kept for a limited number of days.` };
    return {
      today: automation.enabled ? "on" : "off",
      message: automation.enabled ? "Today is on but hasn't made a brief yet." : "Today is off and has never made a brief.",
    };
  }

  const { brief, marks } = saved;
  // A run that stopped before today_finish leaves the file "gathering"; with no run going, it's as ready as it'll get.
  if (brief.status === "gathering" && !hasInFlightRun(db, automation.id)) brief.status = "ready";
  const projectNames = new Map(getProjects(db, workspaceId).map((p) => [p.id, p.name] as const));
  return {
    today: automation.enabled ? "on" : "off",
    ...todayDigest(brief, marks, { includeDone: args.includeDone === true, includeDrafts: args.includeDrafts === true, projectNames }),
  };
}
