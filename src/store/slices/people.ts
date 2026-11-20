/**
 * People slice (People layer, W5): the people list
 * with its suggestions tray, and the selected person's page (relations,
 * timeline, persona note). Plan: docs/plans/people-layer.md.
 *
 * Everything is read through `peopleClient`; writes refetch what they touch
 * rather than patching the list locally, because the list carries derived
 * fields (last met, inverse edges) only the main process computes.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ID } from "@/types";
import type { Person, PersonCreateInput, PersonPatch } from "../../../shared/types/people";
import type { PersonEdgeInput, PersonEdgePatch, PersonPage, PersonSummary } from "../../../shared/types/people-view";
import { peopleClient } from "@/lib/ipc/people";
import { hasElectron, reportIpcError } from "@/lib/ipc/client";

export interface PeopleSlice {
  /** Confirmed people in the active workspace. */
  people: PersonSummary[];
  /** People proposed by capture or an agent (status `suggested`), for the tray. */
  peopleSuggestions: PersonSummary[];
  peopleLoaded: boolean;
  selectedPersonId: ID | null;
  /** The selected person's page; null while loading or when none is selected. */
  personPage: PersonPage | null;
  /** Note ids that are a live person's persona note (all statuses but dismissed), workspace-wide. */
  personaNoteIds: ID[];
  /** Notes view toggle: bring persona notes back into the list and pickers. Session-only, default off. */
  showPersonaNotes: boolean;

  loadPeople: () => Promise<void>;
  loadPersonaNoteIds: () => Promise<void>;
  setShowPersonaNotes: (on: boolean) => void;
  selectPerson: (id: ID | null) => void;
  /** Person shown in Insights' side panel (null = closed). */
  peoplePanelId: ID | null;
  setPeoplePanel: (id: ID | null) => void;
  /**
   * Open a person where the user is: the preview pane beside a full-width chat,
   * else the People view.
   */
  openPerson: (id: ID) => void;
  loadPersonPage: (id: ID) => Promise<void>;
  /** Reload the list and the open page (after an external change). */
  refreshPeople: () => Promise<void>;
  createPerson: (input: Omit<PersonCreateInput, "workspaceId">) => Promise<Person | null>;
  updatePerson: (id: ID, patch: PersonPatch) => Promise<void>;
  deletePerson: (id: ID) => Promise<void>;
  confirmPersonSuggestion: (id: ID) => Promise<void>;
  dismissPersonSuggestion: (id: ID) => Promise<void>;
  addPersonEdge: (input: Omit<PersonEdgeInput, "workspaceId">) => Promise<void>;
  updatePersonEdge: (id: ID, patch: PersonEdgePatch) => Promise<void>;
  removePersonEdge: (id: ID) => Promise<void>;
}

export const createPeopleSlice: StateCreator<CairnStore, [], [], PeopleSlice> = (set, get) => {
  /** Run a write, then refetch the list and the open page. */
  async function write<T>(fn: () => Promise<T>, context: string): Promise<T | null> {
    if (!hasElectron("people")) return null;
    try {
      const out = await fn();
      await get().refreshPeople();
      return out;
    } catch (err) {
      reportIpcError(err, context);
      return null;
    }
  }

  return {
    people: [],
    peopleSuggestions: [],
    peopleLoaded: false,
    selectedPersonId: null,
    personPage: null,
    personaNoteIds: [],
    showPersonaNotes: false,

    async loadPeople() {
      const workspaceId = get().activeWorkspaceId;
      if (!workspaceId || !hasElectron("people")) return;
      try {
        const [people, peopleSuggestions] = await Promise.all([
          peopleClient.summaries({ workspaceId }),
          peopleClient.summaries({ workspaceId, statuses: ["suggested"] }),
        ]);
        if (get().activeWorkspaceId !== workspaceId) return;
        set({ people, peopleSuggestions, peopleLoaded: true });
      } catch (err) {
        reportIpcError(err, "Couldn't load people");
      }
    },

    async loadPersonaNoteIds() {
      const workspaceId = get().activeWorkspaceId;
      if (!workspaceId || !hasElectron("people")) return;
      try {
        const rows = await peopleClient.list({ workspaceId, statuses: ["confirmed", "suggested"], includeArchived: true });
        if (get().activeWorkspaceId !== workspaceId) return;
        const ids = rows.flatMap((p) => (p.personaNoteId ? [p.personaNoteId] : []));
        const prev = get().personaNoteIds;
        if (ids.length !== prev.length || ids.some((id, i) => id !== prev[i])) set({ personaNoteIds: ids });
      } catch (err) {
        console.warn("[people] persona note ids read failed", err);
      }
    },

    setShowPersonaNotes(on) {
      set({ showPersonaNotes: on });
    },

    peoplePanelId: null,

    setPeoplePanel(id) {
      set({ peoplePanelId: id });
    },

    openPerson(id) {
      const s = get();
      if (s.sessionPresentation === "center") {
        s.setActivePreviewItem({ type: "person", id });
        return;
      }
      s.setView("people");
      s.selectPerson(id);
    },

    selectPerson(id) {
      set({ selectedPersonId: id, personPage: null });
      if (id) void get().loadPersonPage(id);
    },

    async loadPersonPage(id) {
      if (!hasElectron("people")) return;
      try {
        const page = await peopleClient.page(id);
        if (get().selectedPersonId !== id) return;
        // A person deleted elsewhere: drop back to the list.
        if (!page) set({ selectedPersonId: null, personPage: null });
        else set({ personPage: page });
      } catch (err) {
        reportIpcError(err, "Couldn't load this person");
      }
    },

    async refreshPeople() {
      const id = get().selectedPersonId;
      await Promise.all([get().loadPeople(), get().loadPersonaNoteIds(), id ? get().loadPersonPage(id) : Promise.resolve()]);
    },

    async createPerson(input) {
      const workspaceId = get().activeWorkspaceId;
      if (!workspaceId) return null;
      return write(() => peopleClient.create({ ...input, workspaceId }), "Couldn't add the person");
    },

    async updatePerson(id, patch) {
      await write(() => peopleClient.update(id, patch), "Couldn't save the person");
    },

    async deletePerson(id) {
      if (get().selectedPersonId === id) set({ selectedPersonId: null, personPage: null });
      await write(() => peopleClient.delete(id), "Couldn't delete the person");
    },

    async confirmPersonSuggestion(id) {
      await write(() => peopleClient.update(id, { status: "confirmed" }), "Couldn't confirm the person");
    },

    async dismissPersonSuggestion(id) {
      // Dismissed, not deleted: the identity is remembered so capture doesn't propose it again.
      await write(() => peopleClient.update(id, { status: "dismissed" }), "Couldn't dismiss the suggestion");
    },

    async addPersonEdge(input) {
      const workspaceId = get().activeWorkspaceId;
      if (!workspaceId) return;
      await write(() => peopleClient.addEdge({ ...input, workspaceId }), "Couldn't add the relationship");
    },

    async updatePersonEdge(id, patch) {
      await write(() => peopleClient.updateEdge(id, patch), "Couldn't update the relationship");
    },

    async removePersonEdge(id) {
      await write(() => peopleClient.removeEdge(id), "Couldn't remove the relationship");
    },
  };
};
