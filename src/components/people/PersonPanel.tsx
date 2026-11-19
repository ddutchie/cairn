"use client";

/**
 * A person's page in a side panel (Insights, and the preview pane beside a
 * full-width chat). It is the same page as in the People view, including Edit,
 * and shares its selection: opening someone here selects them there too.
 */

import React, { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { onChangeFeed } from "@/store/change-feed";
import { EmptyState } from "@/components/ui/empty-state";
import { PersonPage } from "./PersonPage";

export function PersonPanel({ personId }: { personId: string }) {
  const { selectedPersonId, personPage, peopleLoaded, selectPerson, loadPeople, refreshPeople } = useCairnStore(useShallow((s) => ({
    selectedPersonId: s.selectedPersonId, personPage: s.personPage, peopleLoaded: s.peopleLoaded,
    selectPerson: s.selectPerson, loadPeople: s.loadPeople, refreshPeople: s.refreshPeople,
  })));

  useEffect(() => { if (!peopleLoaded) void loadPeople(); }, [peopleLoaded, loadPeople]);
  // Select once per requested person: a deleted person clears the selection again, and reselecting would loop.
  const [requested, setRequested] = useState<string | null>(null);
  useEffect(() => {
    if (requested === personId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- records that this person was asked for, so a not-found result is not requested again
    setRequested(personId);
    if (selectedPersonId !== personId) selectPerson(personId);
  }, [personId, requested, selectedPersonId, selectPerson]);
  // The People view isn't mounted here, so refresh on changes (sync, an agent over MCP) ourselves.
  useEffect(() => onChangeFeed(() => { void refreshPeople(); }), [refreshPeople]);

  const page = selectedPersonId === personId && personPage?.person.id === personId ? personPage : null;
  // Still loading while the selection is ours; after a not-found the selection is cleared and the page never comes.
  if (!page && requested === personId && selectedPersonId !== personId && peopleLoaded) {
    return <EmptyState title="Person not found" className="py-16" />;
  }
  return <PersonPage key={personId} page={page} compact />;
}
