"use client";

/**
 * A person's page in a side panel (Insights, and the preview pane beside a
 * full-width chat). It is the same page as in the People view, including Edit,
 * and shares its selection: opening someone here selects them there too.
 */

import React, { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { onChangeFeed } from "@/store/change-feed";
import { PersonPage } from "./PersonPage";

export function PersonPanel({ personId }: { personId: string }) {
  const { selectedPersonId, personPage, peopleLoaded, selectPerson, loadPeople, refreshPeople } = useCairnStore(useShallow((s) => ({
    selectedPersonId: s.selectedPersonId, personPage: s.personPage, peopleLoaded: s.peopleLoaded,
    selectPerson: s.selectPerson, loadPeople: s.loadPeople, refreshPeople: s.refreshPeople,
  })));

  useEffect(() => { if (!peopleLoaded) void loadPeople(); }, [peopleLoaded, loadPeople]);
  useEffect(() => { if (selectedPersonId !== personId) selectPerson(personId); }, [personId, selectedPersonId, selectPerson]);
  // The People view isn't mounted here, so refresh on changes (sync, an agent over MCP) ourselves.
  useEffect(() => onChangeFeed(() => { void refreshPeople(); }), [refreshPeople]);

  const page = selectedPersonId === personId && personPage?.person.id === personId ? personPage : null;
  return <PersonPage key={personId} page={page} compact />;
}
