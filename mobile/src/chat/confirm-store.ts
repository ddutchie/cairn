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
}

export type PendingConfirm = ConfirmRequest & { id: number };

const slot = createPendingSlot<ConfirmRequest, boolean>(false);

export const askConfirm = (req: ConfirmRequest): Promise<boolean> => slot.ask(req);
export const confirmPending = (): boolean => slot.settle(true);
export const cancelConfirm = (): boolean => slot.cancel();
export const usePendingConfirm: () => PendingConfirm | null = slot.usePending;
