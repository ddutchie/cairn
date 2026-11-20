/** People layer. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { IpcEvents } from "../../shared/ipc/contract";
import type { PeopleStatus, PersonCreateInput, PersonPatch, TeamCreateInput, TeamPatch } from "../../shared/types/people";
import type { MigrationApprovals } from "../../shared/types/people-migration";
import type { AttendeeInput, PeopleListFilter, PersonEdgeInput, PersonEdgePatch } from "../../shared/types/people-view";

export const peopleApi = {
  people: {
    list:       (filter: PeopleListFilter) => invokeContract("db:people:list", filter),
    summaries:  (filter: PeopleListFilter) => invokeContract("db:people:summaries", filter),
    network:    (workspaceId: string) => invokeContract("db:people:network", { workspaceId }),
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
    teams: {
      list:   (workspaceId: string) => invokeContract("db:people:teams:list", { workspaceId }),
      create: (input: TeamCreateInput) => invokeContract("db:people:team:create", input),
      update: (id: string, patch: TeamPatch) => invokeContract("db:people:team:update", { id, patch }),
      delete: (id: string, keepMembers?: boolean) => invokeContract("db:people:team:delete", { id, keepMembers }),
    },
    meetings:       (personId: string, limit?: number) => invokeContract("db:people:meetings", { personId, limit }),
    mentionNoteIds: (personId: string) => invokeContract("db:people:mentionNoteIds", { personId }),
    ownedCardIds:   (personId: string) => invokeContract("db:people:ownedCardIds", { personId }),
    attendees:      (meetingId: string, statuses?: PeopleStatus[]) => invokeContract("db:people:attendees", { meetingId, statuses }),
    attendee: {
      add:    (input: AttendeeInput) => invokeContract("db:people:attendee:add", input),
      remove: (meetingId: string, personId: string) => invokeContract("db:people:attendee:remove", { meetingId, personId }),
    },
    profile: {
      get:     (personId: string) => invokeContract("people:profile:get", { personId }),
      refresh: (personId: string) => invokeContract("people:profile:refresh", { personId }),
    },
    autofill: {
      propose: (personId: string) => invokeContract("people:autofill:propose", { personId }),
    },
    prep: {
      get: (workspaceId: string, personId: string) => invokeContract("people:prep:get", { workspaceId, personId }),
      run: (workspaceId: string, personId: string, meetingId?: string) => invokeContract("people:prep:run", { workspaceId, personId, meetingId }),
      /** A prep run saved a brief for someone. */
      onUpdated: (cb: (payload: IpcEvents["people:prep:updated"]) => void) => onIpcEvent("people:prep:updated", cb),
    },
    migration: {
      inventory: (workspaceId: string) => invokeContract("db:people:migration:inventory", { workspaceId }),
      apply:     (workspaceId: string, approvals: MigrationApprovals, dryRun?: boolean) =>
        invokeContract("db:people:migration:apply", { workspaceId, approvals, dryRun }),
    },
  },
} as const;
