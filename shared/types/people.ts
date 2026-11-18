/**
 * People layer entity types, shared by the main process
 * (`electron/db/people-queries.ts`), the IPC contract and the renderer.
 * Plan: docs/plans/people-layer.md.
 */

import type { ID } from "./domain";

/** Known relationship types; `label` carries anything more specific. */
export const RELATIONSHIP_TYPES = [
  "direct_report", "manager", "peer", "stakeholder", "mentor", "buddy", "recruiter", "candidate", "other",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** How a fact was found: stated in text, from a folder/tag/property pattern, or the model's judgment. */
export const PROVENANCES = ["explicit", "convention", "inferred"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Suggested rows are proposals waiting for the user; dismissed ones are remembered so they don't return. */
export const PEOPLE_STATUSES = ["confirmed", "suggested", "dismissed"] as const;
export type PeopleStatus = (typeof PEOPLE_STATUSES)[number];

export interface Relationship {
  type: RelationshipType;
  /** Free text, e.g. "onboarding buddy", "AA-in-MC trifecta". */
  label?: string;
  provenance: Provenance;
}

export const CADENCES = ["weekly", "biweekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

export type Person = {
  id: ID;
  workspaceId: ID;
  name: string;
  aliases: string[];
  emails: string[];
  slackId?: string;
  /** Relationship to the user. A set: someone can be a stakeholder and a mentor. */
  relationship: Relationship[];
  cadence?: Cadence;
  personaNoteId?: ID;
  status: PeopleStatus;
  provenance: Provenance;
  /** Hiring stage, for candidates. */
  stage?: string;
  /** The user themself; one per workspace. */
  isMe: boolean;
  /** When true, the persona note is left out of every agent read. */
  agentPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

/**
 * Stored person-to-person edge types, one direction each. `partner` is
 * symmetric; the others read "source is <type> target" (source manages target).
 */
export const PERSON_EDGE_TYPES = ["manager_of", "mentor_of", "buddy_of", "stakeholder_of", "partner"] as const;
export type PersonEdgeType = (typeof PERSON_EDGE_TYPES)[number];

/** An edge as seen from one person, including the derived inverse ("reports_to"). */
export type PersonEdgeRole =
  | "manager_of" | "reports_to"
  | "mentor_of" | "mentee_of"
  | "buddy_of" | "buddy_to"
  | "stakeholder_of" | "has_stakeholder"
  | "partner";

export type PersonEdge = {
  id: ID;
  workspaceId: ID;
  sourceId: ID;
  targetId: ID;
  type: PersonEdgeType;
  label?: string;
  /** Set when the relationship is over ("former manager"). */
  endedAt?: string;
  status: PeopleStatus;
  provenance: Provenance;
  sourceNoteId?: ID;
  createdAt: string;
  updatedAt: string;
};

/** One edge from the perspective of `personId`: who's on the other end and in which role. */
export interface PersonRelation {
  edge: PersonEdge;
  role: PersonEdgeRole;
  otherId: ID;
}

export const MEETING_SOURCES = ["calendar", "note", "manual"] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

export type Meeting = {
  id: ID;
  workspaceId: ID;
  title: string;
  startsAt: string;
  endsAt?: string;
  source: MeetingSource;
  /** Calendar event id, so repeated Today runs update rather than duplicate. */
  externalId?: string;
  /** Recurring series, for cadence and "last 1:1". */
  seriesKey?: string;
  createdAt: string;
  updatedAt: string;
};

export const ATTENDEE_SOURCES = ["calendar", "frontmatter", "declared", "body_line", "manual"] as const;
export type AttendeeSource = (typeof ATTENDEE_SOURCES)[number];

export type MeetingAttendee = {
  id: ID;
  meetingId: ID;
  personId: ID;
  /** Suggested when the name match was ambiguous or inferred. */
  status: PeopleStatus;
  source: AttendeeSource;
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
};

export const MENTION_SOURCES = ["wikilink", "owner", "manual"] as const;
export type MentionSource = (typeof MENTION_SOURCES)[number];

export type NoteMention = {
  id: ID;
  noteId: ID;
  personId: ID;
  source: MentionSource;
  createdAt: string;
  updatedAt: string;
};

/** Fields accepted when creating a person (everything but the name is optional). */
export interface PersonCreateInput {
  id?: ID;
  workspaceId: ID;
  name: string;
  aliases?: string[];
  emails?: string[];
  slackId?: string;
  relationship?: Relationship[];
  cadence?: Cadence;
  personaNoteId?: ID;
  status?: PeopleStatus;
  provenance?: Provenance;
  stage?: string;
  isMe?: boolean;
  agentPrivate?: boolean;
}

/** A partial update. `null` clears an optional field. */
export type PersonPatch = Partial<{
  name: string;
  aliases: string[];
  emails: string[];
  slackId: string | null;
  relationship: Relationship[];
  cadence: Cadence | null;
  personaNoteId: ID | null;
  status: PeopleStatus;
  provenance: Provenance;
  stage: string | null;
  isMe: boolean;
  agentPrivate: boolean;
  archivedAt: string | null;
}>;
