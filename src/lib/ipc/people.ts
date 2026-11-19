/**
 * Typed client for the People layer channels (`people:flag:*`, `db:people:*`).
 * Plan: docs/plans/people-layer.md. The view is gated on the flag; the data
 * channels answer either way.
 */

import type {
  Meeting, MeetingAttendee, PeopleStatus, Person, PersonCreateInput, PersonEdge, PersonPatch, PersonRelation,
} from "../../../shared/types/people";
import type {
  AttendeeInput, PeopleListFilter, PersonEdgeInput, PersonEdgePatch, PersonPage, PersonSummary,
} from "../../../shared/types/people-view";
import type { PersonProfile, PrepBrief } from "../../../shared/people/oneonone";
import type { IpcEvents, IpcReturn } from "../../../shared/ipc/contract";
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
  /** Slack profile fields from the device cache; never calls out. */
  profile: (personId: string): Promise<PersonProfile> => people((p) => p.profile.get(personId)),
  /** Refresh from the Slack connector when the cache is older than 24h; resolves with what to show. */
  refreshProfile: (personId: string): Promise<PersonProfile> => people((p) => p.profile.refresh(personId)),
  /** The newest prep brief, and whether one is being prepared. */
  prep: (workspaceId: string, personId: string): Promise<{ brief: PrepBrief | null; running: boolean }> =>
    people((p) => p.prep.get(workspaceId, personId)),
  /** Start a prep brief; `skipped` says why nothing started. */
  runPrep: (workspaceId: string, personId: string, meetingId?: string): Promise<IpcReturn<"people:prep:run">> =>
    people((p) => p.prep.run(workspaceId, personId, meetingId)),
  /** A prep run saved a brief; returns the unsubscribe function (a no-op off-Electron). */
  onPrepUpdated: (cb: (event: IpcEvents["people:prep:updated"]) => void): (() => void) =>
    window.electron?.people?.prep?.onUpdated(cb) ?? (() => {}),
};
