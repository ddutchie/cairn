"use client";

/**
 * A person's page in a side panel (Insights, and the preview pane beside a
 * full-width chat). It is the same page as in the People view, including Edit,
 * but it loads its own copy: the People view's selection (`selectedPersonId`)
 * belongs to that view, so two panels can show different people at once and a
 * deleted person in one never blanks the other.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useCairnStore } from "@/store";
import { onChangeFeed } from "@/store/change-feed";
import { peopleClient } from "@/lib/ipc/people";
import { EmptyState } from "@/components/ui/empty-state";
import type { PersonPage as PersonPageModel } from "../../../shared/types/people-view";
import { PersonPage } from "./PersonPage";

export function PersonPanel({ personId }: { personId: string }) {
  const peopleLoaded = useCairnStore((s) => s.peopleLoaded);
  const loadPeople = useCairnStore((s) => s.loadPeople);
  // Edits go through the store, which reloads the list: that is our cue to reread this page.
  const people = useCairnStore((s) => s.people);
  const [state, setState] = useState<{ id: string; page: PersonPageModel | null } | null>(null);

  const load = useCallback(() => {
    let live = true;
    peopleClient.page(personId).then((page) => { if (live) setState({ id: personId, page }); }).catch(() => {});
    return () => { live = false; };
  }, [personId]);

  useEffect(() => { if (!peopleLoaded) void loadPeople(); }, [peopleLoaded, loadPeople]);
  useEffect(() => load(), [load, people]);
  // The People view isn't mounted here, so reread on changes (sync, an agent over MCP) ourselves.
  useEffect(() => onChangeFeed(() => { load(); }), [load]);

  const mine = state?.id === personId ? state : null;
  if (mine && !mine.page) return <EmptyState title="Person not found" className="py-16" />;
  return <PersonPage key={personId} page={mine?.page ?? null} compact />;
}
