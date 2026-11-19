/**
 * Report and request shapes of the People migration gate (W9): the read-only
 * inventory of a workspace's existing person and meeting notes, and the
 * explicit apply step the user triggers for the candidates they approve.
 * Plan: docs/plans/people-layer.md ("Migrating existing person notes").
 */

import type { ID } from "./domain";
import type { Confidence } from "../people/inventory";

export type { Confidence };

/** What approving a persona candidate would do. */
export type MigrationAction = "create" | "link_existing" | "skip";

/** Why a candidate (or an approval) is skipped. */
export type MigrationSkipReason =
  | "already_linked"      // a person already has this note as their persona note
  | "archived"            // the note is archived
  | "ambiguous_name"      // another candidate note has the same folded name
  | "person_has_persona"  // the matching person already has a different persona note
  | "dismissed"           // the matching person was dismissed by the user
  | "identity_conflict"   // the email matches one person and the name another
  | "removed_by_user"     // the person made from this note was deleted by the user
  | "not_a_candidate"     // the note isn't a live, non-template note of this workspace
  | "no_matching_attendees"; // meeting: nobody listed is (or would become) a known person

/** How a name written in a note resolves, as the capture resolver reads it. */
export type NameResolution = "person" | "candidate" | "ambiguous" | "unknown" | "group";

export interface ResolvedName {
  /** The text as written ("Chris", "[[Sebastien Morel]]" without brackets). */
  text: string;
  resolution: NameResolution;
  /** `person`: the existing person it resolves to. */
  personId?: ID;
  /** `candidate`: the persona note that would become that person; `ambiguous`: every note or person involved. */
  candidateNoteIds?: ID[];
  personIds?: ID[];
}

export interface PersonaCandidate {
  noteId: ID;
  projectId: ID;
  title: string;
  folder: string;
  tags: string[];
  confidence: Confidence;
  score: number;
  reasons: string[];
  /** The person's name as it would be created. */
  name: string;
  aliases: string[];
  emails: string[];
  archived: boolean;
  /** Other candidate notes with the same folded name. Approving either needs a distinct name. */
  ambiguousWith: ID[];
  /** The existing person this note collides with, and how they were matched. */
  existingPerson?: { id: ID; name: string; status: string; matchedBy: "persona_note" | "email" | "name" };
  action: MigrationAction;
  skipReason?: MigrationSkipReason;
  /** First names the corpus uses for exactly this candidate ("Chris"); only added when the user approves them. */
  suggestedAliases: string[];
  /** Notes that `[[link]]` to this note's title. */
  linkedFromNotes: number;
  /** Checklist items owned by a name that resolves to this candidate. */
  ownedItems: number;
}

export interface MeetingCandidate {
  noteId: ID;
  projectId: ID;
  title: string;
  folder: string;
  via: Array<"frontmatter" | "body_line">;
  /** ISO date the note states, if any. */
  date: string | null;
  /** The note is already linked to a meeting. */
  alreadyMeeting: boolean;
  attendees: ResolvedName[];
}

export interface OwnerUse {
  /** Folded owner text. */
  key: string;
  text: string;
  count: number;
  open: number;
  resolution: NameResolution;
  personId?: ID;
  candidateNoteIds?: ID[];
}

export interface AmbiguousShortName {
  text: string;
  candidateNoteIds: ID[];
}

export interface MigrationInventory {
  workspaceId: ID;
  counts: {
    notesScanned: number;
    personaCandidates: number;
    highConfidence: number;
    meetingNotes: number;
    ownedChecklistItems: number;
    openOwnedChecklistItems: number;
    archivedCandidates: number;
    existingPeople: number;
    collisions: number;
    ambiguousNames: number;
  };
  personas: PersonaCandidate[];
  meetings: MeetingCandidate[];
  /** Checklist owners, most used first. */
  owners: OwnerUse[];
  /** Short names (a first name) two or more candidates answer to: they stay unassigned until aliased. */
  ambiguousShortNames: AmbiguousShortName[];
}

/** What the user approved. Everything is matched against the database again at apply time. */
export interface MigrationApprovals {
  personas?: Array<{
    noteId: ID;
    /** Replace the derived name (needed to approve one of two candidates with the same name). */
    name?: string;
    /** Extra aliases to add (for instance an accepted `suggestedAliases` entry). */
    aliases?: string[];
  }>;
  /** Meeting notes whose attendee lines may be attached. */
  meetings?: ID[];
}

export type PersonaOutcome = "created" | "linked" | "unchanged" | "skipped";
export type MeetingOutcome = "captured" | "unchanged" | "skipped";

export interface MigrationResult {
  dryRun: boolean;
  /** False when nothing ran (the People flag is off). */
  applied: boolean;
  reason?: "flag_off";
  personas: Array<{ noteId: ID; outcome: PersonaOutcome; personId?: ID; reason?: MigrationSkipReason }>;
  meetings: Array<{
    noteId: ID;
    outcome: MeetingOutcome;
    meetingId?: ID;
    /** Person ids attending after this run. */
    attendees: ID[];
    /** Person ids added as suggestions (an ambiguous name). */
    suggested: ID[];
    /** Names the note lists that matched nobody (left as text). */
    unmatched: string[];
    reason?: MigrationSkipReason;
  }>;
  /** What the indexing pass added after the people existed. */
  index: { mentionsBefore: number; mentionsAfter: number; ownedItemsBefore: number; ownedItemsAfter: number };
  /** Meeting notes whose frontmatter `attendees`/`date` were (or, in a dry run, would be) rewritten. */
  frontmatterNotes: ID[];
}
