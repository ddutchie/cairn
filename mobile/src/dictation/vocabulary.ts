import { listProjects, listRecentNotes } from "@/db/queries";
import { buildContextualStrings } from "./merge";

const RECENT_NOTES = 60;

/**
 * Project and recent note titles, handed to the recognizer so names Cairn knows
 * ("Garden Planner", "Lisbon trip") are heard correctly. Never throws: dictation
 * works fine without it.
 */
export function dictationVocabulary(): string[] {
  try {
    return buildContextualStrings([
      ...listProjects().map((p) => p.name),
      ...listRecentNotes(RECENT_NOTES).map((n) => n.title),
    ]);
  } catch {
    return [];
  }
}
