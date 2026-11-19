import { useEffect, useMemo } from "react";
import { useCairnStore } from "@/store";
import type { SuggestionItem } from "@/components/chat/ChatInput";

/**
 * Confirmed people as `@` picker entries. Empty while the People layer is off.
 * Picking one writes `@Name`; the engine attaches what Cairn knows about them
 * when the message is sent (`electron/ipc/engine/entry-chat.ts`).
 */
export function usePersonSuggestions(): SuggestionItem[] {
  const enabled = useCairnStore((s) => s.peopleEnabled);
  const people = useCairnStore((s) => s.people);
  const loaded = useCairnStore((s) => s.peopleLoaded);
  const loadPeople = useCairnStore((s) => s.loadPeople);
  useEffect(() => {
    if (enabled && !loaded) void loadPeople();
  }, [enabled, loaded, loadPeople]);
  return useMemo(() => {
    if (!enabled) return [];
    return people.map((p) => ({
      id: p.id,
      type: "person" as const,
      title: p.name,
      subtitle: p.relationship[0] ? (p.relationship[0].label || p.relationship[0].type).replace(/_/g, " ") : "Person",
    }));
  }, [enabled, people]);
}
