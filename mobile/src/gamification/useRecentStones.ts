import { useCallback, useState } from "react";
import { listRecentNotes } from "@/db/queries";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { MAX_STONES, type StoneInput } from "./stones";

function read(): StoneInput[] {
  try {
    return listRecentNotes(MAX_STONES);
  } catch {
    return [];
  }
}

/**
 * The notes behind the cairn stack, refreshed on focus and whenever synced data
 * changes. When `enabled` is false it never touches the database. `newestId` flips when a note is added, which is what makes a stone
 * drop in.
 */
export function useRecentStones(enabled = true): { inputs: StoneInput[]; newestId: string | null } {
  const [inputs, setInputs] = useState<StoneInput[]>(() => (enabled ? read() : []));
  const load = useCallback(() => {
    if (enabled) setInputs(read());
  }, [enabled]);
  useRefreshOnFocus(load);
  // listRecentNotes is newest-first, so the first row is the newest note.
  return { inputs, newestId: inputs[0]?.id ?? null };
}
