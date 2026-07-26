import { toast } from "@/components/Toast";
import { confetti } from "@/components/Confetti";
import { haptics } from "@/haptics";
import type { ColumnRow } from "@/db/queries";

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

/** Re-exported for call sites that want the raw buzz without a toast. */
export const rewardHaptics = haptics;
