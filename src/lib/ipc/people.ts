/**
 * Typed client for the People layer channels (`people:flag:*`, `db:people:*`).
 * Plan: docs/plans/people-layer.md. The view is gated on the flag; the data
 * channels answer either way.
 */

import type {
  Meeting, MeetingAttendee, PeopleStatus, Person, PersonCreateInput, PersonEdge, PersonPatch, PersonRelation,
} from "../../../shared/types/people";
import type { MigrationApprovals, MigrationInventory, MigrationResult } from "../../../shared/types/people-migration";
import type {
  AttendeeInput, PeopleListFilter, PersonEdgeInput, PersonEdgePatch, PersonPage, PersonSummary,
} from "../../../shared/types/people-view";
import { domainCall, type ElectronApi } from "./client";

const people = <T>(fn: (api: ElectronApi["people"]) => Promise<T>) => domainCall("people", fn);

export const peopleClient = {
  isEnabled: (): Promise<boolean> => people((p) => p.flag.get()),
  setEnabled: (on: boolean): Promise<boolean> => people((p) => p.flag.set(on)),
  list: (filter: PeopleListFilter): Promise<Person[]> => people((p) => p.list(filter)),
  summaries: (filter: PeopleListFilter): Promise<PersonSummary[]> => people((p) => p.summaries(filter)),
  get: (id: string): Promise<Person | null> => people((p) => p.get(id)),
  page: (id: string): Promise<PersonPage | null> => people((p) => p.page(id)),
  create: (input: PersonCreateInput): Promise<Person> => people((p) => p.create(input)),
  update: (id: string, patch: PersonPatch): Promise<Person> => people((p) => p.update(id, patch)),
  delete: (id: string): Promise<void> => people((p) => p.delete(id)),
  relations: (personId: string, opts?: { statuses?: PeopleStatus[]; includeEnded?: boolean }): Promise<PersonRelation[]> =>
    people((p) => p.relations(personId, opts)),
  addEdge: (input: PersonEdgeInput): Promise<PersonEdge> => people((p) => p.edge.add(input)),
  updateEdge: (id: string, patch: PersonEdgePatch): Promise<PersonEdge> => people((p) => p.edge.update(id, patch)),
  removeEdge: (id: string): Promise<void> => people((p) => p.edge.remove(id)),
  meetings: (personId: string, limit?: number): Promise<Meeting[]> => people((p) => p.meetings(personId, limit)),
  mentionNoteIds: (personId: string): Promise<string[]> => people((p) => p.mentionNoteIds(personId)),
  ownedCardIds: (personId: string): Promise<string[]> => people((p) => p.ownedCardIds(personId)),
  attendees: (meetingId: string, statuses?: PeopleStatus[]): Promise<MeetingAttendee[]> =>
    people((p) => p.attendees(meetingId, statuses)),
  addAttendee: (input: AttendeeInput): Promise<MeetingAttendee> => people((p) => p.attendee.add(input)),
  removeAttendee: (meetingId: string, personId: string): Promise<void> => people((p) => p.attendee.remove(meetingId, personId)),
  /** Read-only: the person and meeting notes the workspace already has. */
  migrationInventory: (workspaceId: string): Promise<MigrationInventory> => people((p) => p.migration.inventory(workspaceId)),
  /** Writes only what `approvals` lists; `dryRun` reports without writing. */
  migrationApply: (workspaceId: string, approvals: MigrationApprovals, dryRun?: boolean): Promise<MigrationResult> =>
    people((p) => p.migration.apply(workspaceId, approvals, dryRun)),
};
