import { toast } from "@/components/Toast";
import { confetti } from "@/components/Confetti";
import { haptics } from "@/haptics";
import type { ColumnRow } from "@/db/queries";
import { nextMilestoneToCelebrate } from "./milestones";

/**
 * Gamified reward moments — the single place that decides what feedback a user
 * action earns, so the board, card-detail, and any future call sites stay in
 * sync. Keeps the "is this a celebration?" logic out of the UI components.
 */

/** A column counts as a completion target when its type is "done". */
export function isDoneColumn(col: Pick<ColumnRow, "type"> | undefined | null): boolean {
  return col?.type === "done";
}

const DONE_LINES = [
  "Nice — task done",
  "Boom. Done.",
  "One down!",
  "Crushed it",
  "Task complete",
];

/**
 * Celebrate moving a card into a done column: a success haptic + a toast. Call
 * this only when the move actually crosses INTO a done column (not a reorder
 * within done, not a move back out). The toast fires its own success haptic, so
 * we let it handle the buzz (haptic: true default) — no double-fire.
 *
 * `remainingOpen` is the number of not-done cards left in the project AFTER this
 * completion; when it hits 0 we upgrade to a bigger "all clear" message. (The
 * confetti burst is layered on top of this in a later step.)
 */
export function celebrateTaskDone(remainingOpen: number): void {
  confetti();
  if (remainingOpen <= 0) {
    toast.success("All tasks done!", { detail: "The board is clear — nice work.", durationMs: 3200 });
    return;
  }
  const line = DONE_LINES[Math.floor(Math.random() * DONE_LINES.length)];
  const detail = remainingOpen === 1 ? "1 task to go" : `${remainingOpen} tasks to go`;
  toast.success(line, { detail });
}

/**
 * Celebrate a project crossing a completion milestone (25/50/75/100%). Driven by
 * `computeProjectMetrics().completionRate` (0–100) from the Overview. Fires at
 * most once per milestone per project per session — the module map means it
 * survives tab switches / remounts but resets on relaunch (the moment itself
 * deserves the confetti again). No-op when there are no cards.
 *
 * `allCards` gates the 100% toast wording: a project that completes with a
 * single card is just "that task"; one with several gets the "whole board"
 * message.
 */
export function celebrateProjectMilestone(projectId: string, completionRate: number, allCards: number): void {
  const crossed = nextMilestoneToCelebrate(projectId, completionRate, allCards);
  if (crossed === 0) return;

  confetti();
  if (crossed === 100) {
    toast.success(
      allCards === 1 ? "Project complete!" : "Whole board clear!",
      { detail: allCards === 1 ? "That project is done." : `All ${allCards} tasks done — nice work.`, durationMs: 3200 },
    );
    return;
  }
  toast.success(`${crossed}% complete`, { detail: `${completionRate}% of tasks done — keep going.` });
}

/** Re-exported for call sites that want the raw buzz without a toast. */
export const rewardHaptics = haptics;
