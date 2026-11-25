/**
 * What The Workspace (the idle office) reads from the workspace: each project's
 * cards by board zone, with assignee and due state, and its notes. Unlike the
 * arcade games it is not capped to a handful of items: the office is a mirror,
 * and the layout decides how much fits (the rest shows as "+N").
 *
 * Pure data, no platform code. Hosts build it (desktop: `src/components/arcade/office-data.ts`).
 */

import type { ColumnType, Priority } from "../../types/domain";
import { ACCENTS, cleanArcadeTitle } from "../pixel/arcade-data";

/** Where a card sits in a room: shelf, desks, review table, or the done cabinet. */
export type Zone = "backlog" | "doing" | "review" | "done";

export interface OfficeCard {
  id: string;
  title: string;
  columnId: string;
  priority: Priority;
  zone: Zone;
  /** Free-text assignee from the card, trimmed; null when nobody holds it. */
  assignee: string | null;
  overdue: boolean;
  dueToday: boolean;
  /** The card's due date ("yyyy-MM-dd") for the week wall; null when unscheduled. */
  dueKey: string | null;
}

export interface OfficeNote {
  id: string;
  title: string;
  pinned: boolean;
  /** Changes whenever the note is edited (its updated-at), so an edit can be told from a rename. */
  rev?: string;
}

export interface OfficeColumn {
  id: string;
  name: string;
  zone: Zone;
}

export interface OfficeProject {
  id: string;
  name: string;
  accent: string;
  /** Board columns in order (done columns included: they show the week's count). */
  columns: OfficeColumn[];
  /** Open cards (not in a done column), in board order within each zone. */
  cards: OfficeCard[];
  notes: OfficeNote[];
  /** Cards finished in the last seven days: the done cabinet shows the count. */
  doneThisWeek: number;
  /** Cards finished ever (done columns): decor milestones, not a score. */
  doneTotal: number;
}

export interface OfficeData {
  workspace: string;
  projects: OfficeProject[];
  /** The demo office: clicks open nothing, and the host says so. */
  demo: boolean;
}


/** A column type's zone. Custom columns take their place by position (before or after the first in-progress column). */
export function zoneForColumn(type: ColumnType, afterDoing = false): Zone {
  switch (type) {
    case "backlog":
    case "todo":
      return "backlog";
    case "in_progress":
      return "doing";
    case "review":
      return "review";
    case "done":
      return "done";
    default:
      return afterDoing ? "review" : "backlog";
  }
}

/** The worker who holds a card: its assignee, or the shared "contractor" for unassigned work at the desks. */
export const CONTRACTOR = "CONTRACTOR";
export const holderOf = (c: OfficeCard): string => c.assignee ?? CONTRACTOR;

/** A card title cleaned for the pixel font, without the arcade's tight cap (the hint bar has room). */
export const officeTitle = (s: string): string => cleanArcadeTitle(s);

const DEMO_COLUMNS: [string, Zone][] = [["TO DO", "backlog"], ["IN PROGRESS", "doing"], ["REVIEW", "review"], ["DONE", "done"]];
const demoColumns = (p: string): OfficeColumn[] => DEMO_COLUMNS.map(([name, zone]) => ({ id: `demo-${p}-${zone}`, name, zone }));

const demoCard = (id: string, title: string, zone: Zone, assignee: string | null, priority: Priority = "medium", overdue = false): OfficeCard => ({
  id: `demo-${id}`,
  title,
  columnId: `demo-${id[0]}-${zone}`,
  priority,
  zone,
  assignee,
  overdue,
  dueToday: false,
  dueKey: null,
});

const demoNote = (id: string, title: string, pinned = false): OfficeNote => ({ id: `demo-${id}`, title, pinned });

/** A small made-up company, used when the workspace has nothing to show. Column ids are `demo-<project letter>-<zone>`. */
export const DEMO_OFFICE: OfficeData = {
  workspace: "DEMO WORKSPACE",
  demo: true,
  projects: [
    {
      id: "demo-launch",
      columns: demoColumns("l"),
      name: "LAUNCH",
      accent: ACCENTS[0],
      doneThisWeek: 7,
      doneTotal: 23,
      cards: [
        demoCard("l1", "PRICING PAGE COPY", "doing", "SAM", "high"),
        demoCard("l2", "PRESS KIT", "doing", "SAM"),
        demoCard("l3", "ONBOARDING EMAILS", "doing", "RIO", "urgent", true),
        demoCard("l4", "DEMO VIDEO", "review", "RIO"),
        demoCard("l5", "CHANGELOG", "backlog", null, "low"),
        demoCard("l6", "BETA INVITES", "backlog", null),
        demoCard("l7", "STATUS PAGE", "backlog", null),
        demoCard("l8", "FAQ", "doing", null),
      ],
      notes: [demoNote("ln1", "LAUNCH PLAN", true), demoNote("ln2", "AUDIENCE"), demoNote("ln3", "RISKS"), demoNote("ln4", "MESSAGING")],
    },
    {
      id: "demo-app",
      columns: demoColumns("a"),
      name: "MOBILE APP",
      accent: ACCENTS[2],
      doneThisWeek: 3,
      doneTotal: 14,
      cards: [
        demoCard("a1", "OFFLINE SYNC", "doing", "KIM", "high"),
        demoCard("a2", "WIDGETS", "doing", "LEE"),
        demoCard("a3", "DARK MODE", "review", "LEE"),
        demoCard("a4", "CRASH ON RESUME", "backlog", null, "urgent", true),
        demoCard("a5", "SETTINGS SCREEN", "backlog", null),
      ],
      notes: [demoNote("an1", "ARCHITECTURE", true), demoNote("an2", "RELEASE CHECKLIST")],
    },
    {
      id: "demo-research",
      columns: demoColumns("r"),
      name: "RESEARCH",
      accent: ACCENTS[4],
      doneThisWeek: 1,
      doneTotal: 4,
      cards: [demoCard("r1", "INTERVIEW 5 USERS", "doing", "ADA"), demoCard("r2", "SYNTHESIS", "backlog", null)],
      notes: [demoNote("rn1", "INTERVIEW GUIDE"), demoNote("rn2", "FINDINGS"), demoNote("rn3", "PERSONAS"), demoNote("rn4", "COMPETITORS"), demoNote("rn5", "READING LIST")],
    },
  ],
};
