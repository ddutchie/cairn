/** People layer (behind the `feature.people` flag). */

import { invokeContract } from "./ipc";
import type { PeopleStatus, PersonCreateInput, PersonPatch } from "../../shared/types/people";
import type { AttendeeInput, PeopleListFilter, PersonEdgeInput, PersonEdgePatch } from "../../shared/types/people-view";

export const peopleApi = {
  people: {
    flag: {
      get: () => invokeContract("people:flag:get"),
      set: (on: boolean) => invokeContract("people:flag:set", { on }),
    },
    list:       (filter: PeopleListFilter) => invokeContract("db:people:list", filter),
    summaries:  (filter: PeopleListFilter) => invokeContract("db:people:summaries", filter),
    get:        (id: string) => invokeContract("db:people:get", { id }),
    page:       (id: string) => invokeContract("db:people:page", { id }),
    create:     (input: PersonCreateInput) => invokeContract("db:people:create", input),
    update:     (id: string, patch: PersonPatch) => invokeContract("db:people:update", { id, patch }),
    delete:     (id: string) => invokeContract("db:people:delete", { id }),
    relations:  (personId: string, opts: { statuses?: PeopleStatus[]; includeEnded?: boolean } = {}) =>
      invokeContract("db:people:relations", { personId, ...opts }),
    edge: {
      add:    (input: PersonEdgeInput) => invokeContract("db:people:edge:add", input),
      update: (id: string, patch: PersonEdgePatch) => invokeContract("db:people:edge:update", { id, patch }),
      remove: (id: string) => invokeContract("db:people:edge:remove", { id }),
    },
    meetings:       (personId: string, limit?: number) => invokeContract("db:people:meetings", { personId, limit }),
    mentionNoteIds: (personId: string) => invokeContract("db:people:mentionNoteIds", { personId }),
    ownedCardIds:   (personId: string) => invokeContract("db:people:ownedCardIds", { personId }),
    attendees:      (meetingId: string, statuses?: PeopleStatus[]) => invokeContract("db:people:attendees", { meetingId, statuses }),
    attendee: {
      add:    (input: AttendeeInput) => invokeContract("db:people:attendee:add", input),
      remove: (meetingId: string, personId: string) => invokeContract("db:people:attendee:remove", { meetingId, personId }),
    },
  },
} as const;
