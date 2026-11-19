"use client";

/**
 * A person's page in a side panel (Insights, and the preview pane beside a
 * full-width chat). It is the same page as in the People view, including Edit,
 * but it loads its own copy: the People view's selection (`selectedPersonId`)
 * belongs to that view, so two panels can show different people at once and a
 * deleted person in one never blanks the other.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
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
  // Only the newest read may land, and none after unmount or a switch to another person.
  const latest = useRef(0);
  const hasPage = useRef(false);

  const load = useCallback(() => {
    const n = ++latest.current;
    peopleClient.page(personId).then((page) => {
      if (n !== latest.current) return;
      hasPage.current = true;
      setState({ id: personId, page });
    }).catch(() => {});
  }, [personId]);

  useEffect(() => { if (!peopleLoaded) void loadPeople(); }, [peopleLoaded, loadPeople]);
  useEffect(() => {
    hasPage.current = false;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a counter, not a DOM ref: bumping it is the point, so reads still in flight are dropped
    return () => { latest.current++; };
  }, [load]);
  // The list changing means something was saved (here, sync or an agent). Before the first page has landed
  // the read in flight is already fresh, so don't read twice.
  useEffect(() => { if (hasPage.current) load(); }, [people, load]);
  // The People view isn't mounted here, so reload the list on changes ourselves; that also rereads the page.
  useEffect(() => onChangeFeed(() => { void loadPeople(); }), [loadPeople]);

  const mine = state?.id === personId ? state : null;
  if (mine && !mine.page) return <EmptyState title="Person not found" className="py-16" />;
  return <PersonPage key={personId} page={mine?.page ?? null} compact />;
}
