/**
 * Read models and IPC inputs for the People view (W5). The entity types live
 * in `./people`; these are the shapes the `db:people:*` channels add on top.
 * Plan: docs/plans/people-layer.md ("Surfaces").
 */

import type { ID } from "./domain";
import type {
  AttendeeSource, Meeting, PeopleStatus, Person, PersonEdgeType, PersonRelation, Provenance, RelationshipType,
} from "./people";

/** A person in the list, with the dates the list shows. */
export type PersonSummary = Person & {
  /** Start of the latest confirmed meeting they attended that has begun. */
  lastMetAt?: string;
  /** Start of their next confirmed meeting (a slot for the 1:1 loop). */
  nextMeetingAt?: string;
};

/** A relation with the other person's name, for the person page header. */
export type PersonRelationView = PersonRelation & { otherName: string };

export interface TimelineNoteRef {
  id: ID;
  projectId: ID;
  title: string;
  updatedAt: string;
}

export type PersonTimelineItem =
  | {
      kind: "meeting";
      at: string;
      meeting: Meeting;
      /** Notes linked to the meeting (prep, minutes). */
      notes: TimelineNoteRef[];
      /** The other confirmed attendees. */
      with: { personId: ID; name: string }[];
    }
  | { kind: "mention"; at: string; note: TimelineNoteRef }
  | {
      kind: "card";
      at: string;
      card: { id: ID; projectId: ID; title: string; columnName: string; done: boolean; updatedAt: string };
    };

export interface PersonaNote {
  id: ID;
  projectId: ID;
  title: string;
  content: string;
}

/** Everything the person page shows, in one read. */
export interface PersonPage {
  person: Person;
  relations: PersonRelationView[];
  /** Newest first. */
  timeline: PersonTimelineItem[];
  persona: PersonaNote | null;
  lastMetAt?: string;
  nextMeetingAt?: string;
}

/** `db:people:list` filter. Default: confirmed, not archived. */
export interface PeopleListFilter {
  workspaceId: ID;
  statuses?: PeopleStatus[];
  relationship?: RelationshipType;
  includeArchived?: boolean;
}

/** `db:people:edge:add` input (same fields as `addEdge` in electron/db/people-queries.ts). */
export interface PersonEdgeInput {
  workspaceId: ID;
  sourceId: ID;
  targetId: ID;
  type: PersonEdgeType;
  label?: string;
  endedAt?: string;
  status?: PeopleStatus;
  provenance?: Provenance;
  sourceNoteId?: ID;
}

export type PersonEdgePatch = Partial<{ label: string | null; endedAt: string | null; status: PeopleStatus }>;

/** `db:people:attendee:add` input (same fields as `addAttendee`). */
export interface AttendeeInput {
  meetingId: ID;
  personId: ID;
  status?: PeopleStatus;
  source?: AttendeeSource;
  provenance?: Provenance;
}
