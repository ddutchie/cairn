import { createPendingSlot } from "./pending-slot";

/**
 * A Delete / Cancel card the running turn is waiting on: the `delete` tool
 * awaits `askConfirm` and only deletes on `true`. Cancel, Clear chat, leaving the
 * chat screen, or a newer ask all settle it as `false`.
 */
export interface ConfirmRequest {
  /** What is about to happen, e.g. "Delete the note “Plan”?" */
  title: string;
  /** One line under the title (where the item lives, what else goes with it). */
  detail?: string;
  /** The destructive button, e.g. "Delete note". */
  confirmLabel: string;
  /** "neutral" for an allow-or-not question (a connector call) rather than a destructive one. Default "danger". */
  tone?: "danger" | "neutral";
  /** When set, the card also offers "Always allow" for this key until the chat is cleared or the app restarts. */
  rememberKey?: string;
}

export type PendingConfirm = ConfirmRequest & { id: number };

const slot = createPendingSlot<ConfirmRequest, boolean>(false);

export const askConfirm = (req: ConfirmRequest): Promise<boolean> => slot.ask(req);
export const confirmPending = (): boolean => slot.settle(true);
export const cancelConfirm = (): boolean => slot.cancel();
export const usePendingConfirm: () => PendingConfirm | null = slot.usePending;

// ── "Always allow" for connector tools, for this session only ─────────────────
// In memory on purpose: a grant must not outlive the app, and is dropped on Clear chat.
const allowed = new Set<string>();
export const isAllowedForSession = (key: string): boolean => allowed.has(key);
export const allowForSession = (key: string): void => void allowed.add(key);
export const clearSessionAllows = (): void => allowed.clear();
