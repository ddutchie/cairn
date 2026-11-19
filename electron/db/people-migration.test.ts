import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { seedPeopleCorpus, type PeopleCorpus } from "../test-support/people-corpus";
import { applyMigration, buildInventory } from "./people-migration";
import { indexNotePeople } from "./people-indexing";
import { deletePerson, getPerson, listAttendees, listPeople, setPeopleEnabled, updatePerson } from "./people-queries";
import { migratedPersonId } from "../../shared/people/ids";
import type { MigrationApprovals, PersonaCandidate } from "../../shared/types/people-migration";

let db: Database.Database;
let c: PeopleCorpus;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
  c = seedPeopleCorpus(db);
});
afterEach(() => db.close());

const inventory = () => buildInventory(db, "ws1", { readFrontmatter: c.readFrontmatter });
const apply = (approvals: MigrationApprovals, dryRun = false, refresh?: (ids: string[]) => { written: string[]; failed: string[] }) =>
  applyMigration(db, "ws1", approvals, { dryRun, readFrontmatter: c.readFrontmatter, refreshFrontmatter: refresh });
const cand = (key: string): PersonaCandidate => inventory().personas.find((p) => p.noteId === c.n[key])!;

/** Every table the migration could touch, with its rows: a change anywhere, even an `updated_at`, shows. */
const TABLES = ["people", "person_edges", "meetings", "meeting_attendees", "note_mentions", "note_action_items", "notes", "task_cards", "sync_pending", "sync_oplog"];
function snapshot(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    try { out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(); } catch { /* table absent on this schema */ }
  }
  return out;
}

/** What an approve-everything-safe click would send. */
function approveAll(extra: Partial<MigrationApprovals> = {}): MigrationApprovals {
  const inv = inventory();
  return {
    personas: inv.personas.filter((p) => p.action !== "skip" && p.confidence !== "low").map((p) => ({ noteId: p.noteId })),
    meetings: inv.meetings.map((m) => m.noteId),
    ...extra,
  };
}

/** The approve-all list with Ana's accepted first-name alias on her own entry. */
const withAnaAlias = () => (approveAll().personas ?? []).map((p) => (p.noteId === c.n.ana ? { ...p, aliases: ["Ana"] } : p));

describe("inventory", () => {
  it("finds the persona candidates with confidence and reasons, and leaves out deleted notes and other workspaces", () => {
    const names = inventory().personas.map((p) => p.name);
    expect(names).toEqual([
      "Ana Ruiz", "Ben Okafor", "Chris Lang", "Chris Moreau", "Cleo Marsh", "Dmitri Volkov", "Elena Fischer", "Farid Haddad",
      "Grace Lindqvist", "Hana Sato", "Hiring Pipeline Overview", "Iris Novak", "Jonas Weber", "Sam Whitfield", "Sam Whitfield",
    ]);
    expect(cand("ana")).toMatchObject({ confidence: "high" });
    expect(cand("ana").reasons.join(" ")).toContain("tagged person");
    expect(cand("elena")).toMatchObject({ name: "Elena Fischer", confidence: "high" }); // "Persona - " prefix removed
    expect(cand("cleo")).toMatchObject({ confidence: "medium" }); // Discussions/<Name> folder
    expect(cand("pipeline")).toMatchObject({ confidence: "low" }); // a topic note in a People folder
    // No signal, no candidate: a name-like title alone, and a plain topic.
    expect(inventory().personas.some((p) => p.noteId === c.n.maria || p.noteId === c.n.quarterly)).toBe(false);
    expect(inventory().personas.some((p) => p.noteId === c.n.kira || p.noteId === c.n.otherAna)).toBe(false);
  });

  it("takes nicknames and an email alias from the title, the frontmatter and the body", () => {
    expect(cand("dima")).toMatchObject({ name: "Dmitri Volkov", aliases: ["Dima"] });
    expect(cand("farid")).toMatchObject({ aliases: ["Fari"], emails: ["f.haddad@example.com"] });
    expect(cand("jonas").emails).toEqual(["jonas@example.com"]);
  });

  it("marks two notes with the same name as ambiguous and skips both", () => {
    const [a, b] = [cand("samA"), cand("samB")];
    expect(a.ambiguousWith).toEqual([b.noteId]);
    expect(b.ambiguousWith).toEqual([a.noteId]);
    expect(a).toMatchObject({ action: "skip", skipReason: "ambiguous_name" });
    expect(inventory().counts.ambiguousNames).toBe(2);
  });

  it("reports collisions with existing people, by name and by email, and archived notes", () => {
    expect(cand("iris")).toMatchObject({ action: "link_existing", existingPerson: { id: c.people.iris, matchedBy: "name", status: "suggested" } });
    expect(cand("jonas")).toMatchObject({ action: "link_existing", existingPerson: { id: c.people.jw, matchedBy: "email" } });
    expect(cand("hana")).toMatchObject({ archived: true, action: "skip", skipReason: "archived" });
    expect(inventory().counts).toMatchObject({ collisions: 2, archivedCandidates: 1, existingPeople: 2 });
  });

  it("finds meeting-like notes by frontmatter and by body lines, and ignores prose, code blocks and journal dates", () => {
    const meetings = inventory().meetings;
    expect(meetings.map((m) => m.noteId).sort()).toEqual([c.n.m1, c.n.m2, c.n.m3, c.n.m4, c.n.m5, c.n.m6].sort());
    const by = (k: string) => meetings.find((m) => m.noteId === c.n[k])!;
    expect(by("m1")).toMatchObject({ via: ["body_line"], date: "2026-11-03T00:00:00.000Z" });
    expect(by("m2").via).toEqual(["frontmatter"]);
    expect(by("m2").attendees.map((a) => a.text)).toEqual(["Ana Ruiz", "Cleo Marsh"]);
    expect(by("m4").attendees.map((a) => [a.text, a.resolution])).toEqual([["Elena Fischer", "candidate"], ["Fari", "candidate"]]);
    expect(by("m5").via).toEqual(["frontmatter", "body_line"]);
    expect(by("m6").attendees.map((a) => a.text)).toEqual(["Farid Haddad", "Iris Novak"]);
    expect(by("m6").attendees[1]).toMatchObject({ resolution: "person", personId: c.people.iris });
    // "Participants: users, admins", "Attendees were late", a fenced **Attendees:** and a journal `date`.
    for (const k of ["prose", "journal", "plain"]) expect(meetings.some((m) => m.noteId === c.n[k])).toBe(false);
  });

  it("counts owned checklist items and resolves owners the way capture will", () => {
    const inv = inventory();
    expect(inv.counts).toMatchObject({ ownedChecklistItems: 20, openOwnedChecklistItems: 18 }); // the fenced item and "milk" don't count
    const owner = (text: string) => inv.owners.find((o) => o.text === text)!;
    expect(owner("Chris Moreau")).toMatchObject({ resolution: "candidate", candidateNoteIds: [c.n.chrisM] });
    expect(owner("Grace Lindqvist")).toMatchObject({ resolution: "candidate" });
    expect(owner("Team").resolution).toBe("group");
    // The first names nobody has aliased yet are unknown, not guessed.
    expect(owner("Ana").resolution).toBe("unknown");
  });

  it("suggests a first name as an alias only when it points at exactly one candidate", () => {
    expect(cand("ana").suggestedAliases).toEqual(["Ana"]);
    expect(cand("ben").suggestedAliases).toEqual(["Ben"]);
    expect(cand("chrisM").suggestedAliases).toEqual([]);
    expect(inventory().ambiguousShortNames).toEqual([{ text: "Chris", candidateNoteIds: [c.n.chrisL, c.n.chrisM].sort() }]);
  });

  it("counts links and owned items per candidate", () => {
    expect(cand("ana").linkedFromNotes).toBe(1); // m2's body
    expect(cand("chrisM").ownedItems).toBe(1); // "Chris Moreau", not the bare "Chris"
  });

  it("never writes, and works with the flag off", () => {
    expect(listPeople(db, "ws1", { statuses: ["confirmed", "suggested"] }).length).toBe(2);
    const before = snapshot();
    inventory();
    inventory();
    expect(snapshot()).toEqual(before);
  });
});

describe("apply: gates", () => {
  it("does nothing while the People flag is off", () => {
    const before = snapshot();
    const r = apply(approveAll());
    expect(r).toMatchObject({ applied: false, reason: "flag_off", personas: [], meetings: [] });
    expect(snapshot()).toEqual(before);
  });

  it("does nothing without approvals", () => {
    setPeopleEnabled(db, true);
    const before = snapshot();
    const r = apply({});
    expect(r).toMatchObject({ applied: true, personas: [], meetings: [] });
    expect(snapshot()).toEqual(before);
  });

  it("a dry run reports what a real run does and writes nothing", () => {
    setPeopleEnabled(db, true);
    const approvals = approveAll();
    const before = snapshot();
    const preview = apply(approvals, true);
    expect(snapshot()).toEqual(before);
    const real = apply(approvals);
    expect({ ...preview, dryRun: false, frontmatterNotes: [] }).toEqual({ ...real, frontmatterNotes: [] });
    expect(preview.personas.filter((p) => p.outcome === "created").length).toBeGreaterThan(5);
  });

  it("only touches what was approved", () => {
    setPeopleEnabled(db, true);
    const r = apply({ personas: [{ noteId: c.n.ana }] });
    expect(r.personas).toEqual([{ noteId: c.n.ana, outcome: "created", personId: migratedPersonId("ws1", c.n.ana) }]);
    expect(listPeople(db, "ws1", { statuses: ["confirmed", "suggested"] }).map((p) => p.name).sort()).toEqual(["Ana Ruiz", "Iris Novak", "J. Weber"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 0 });
    // No meeting was approved, so the body pass left meeting notes alone.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE meeting_id IS NOT NULL").get()).toEqual({ n: 0 });
  });
});

describe("apply: people", () => {
  beforeEach(() => setPeopleEnabled(db, true));

  it("creates a confirmed person linked to the persona note, with a deterministic id", () => {
    const r = apply({ personas: [{ noteId: c.n.dima }, { noteId: c.n.farid }] });
    const dima = getPerson(db, migratedPersonId("ws1", c.n.dima))!;
    expect(r.personas.map((p) => p.outcome)).toEqual(["created", "created"]);
    expect(dima).toMatchObject({ name: "Dmitri Volkov", personaNoteId: c.n.dima, status: "confirmed", provenance: "convention", workspaceId: "ws1" });
    expect(dima.aliases).toEqual(["Dima", "Dmitri Volkov (Dima)"]); // nickname and the persona title
    expect(getPerson(db, migratedPersonId("ws1", c.n.farid))).toMatchObject({ emails: ["f.haddad@example.com"], aliases: ["Fari"] });
  });

  it("links an existing person instead of creating a duplicate, by name and by email", () => {
    const before = listPeople(db, "ws1", { statuses: ["confirmed", "suggested"] }).length;
    const r = apply({ personas: [{ noteId: c.n.iris }, { noteId: c.n.jonas }] });
    expect(r.personas).toEqual([
      { noteId: c.n.iris, outcome: "linked", personId: c.people.iris },
      { noteId: c.n.jonas, outcome: "linked", personId: c.people.jw },
    ]);
    expect(listPeople(db, "ws1", { statuses: ["confirmed", "suggested"] }).length).toBe(before);
    expect(getPerson(db, c.people.iris)).toMatchObject({ personaNoteId: c.n.iris, status: "confirmed" }); // the stub is confirmed by the approval
    expect(getPerson(db, c.people.jw)).toMatchObject({ personaNoteId: c.n.jonas, emails: ["jonas@example.com"] });
  });

  it("skips ambiguous, archived, unknown and low-risk-but-unapproved notes, and says why", () => {
    const r = apply({ personas: [{ noteId: c.n.samA }, { noteId: c.n.hana }, { noteId: c.n.maria }, { noteId: c.n.otherAna }] });
    expect(r.personas.map((p) => [p.outcome, p.reason])).toEqual([
      ["skipped", "ambiguous_name"], ["skipped", "archived"], ["skipped", "not_a_candidate"], ["skipped", "not_a_candidate"],
    ]);
    expect(getPerson(db, migratedPersonId("ws1", c.n.samA))).toBeNull();
  });

  it("decides two notes with one name together, so the bare name never points at only one of them", () => {
    // One alone is refused, even with a distinct name: the other's note still carries the shared title.
    const alone = apply({ personas: [{ noteId: c.n.samA, name: "Sam Whitfield (support)" }] });
    expect(alone.personas[0]).toMatchObject({ outcome: "skipped", reason: "ambiguous_name" });
    expect(getPerson(db, migratedPersonId("ws1", c.n.samA))).toBeNull();
    // Both with the same name: the second would be linked to the first, so it is refused.
    const same = apply({ personas: [{ noteId: c.n.samA }, { noteId: c.n.samB }] });
    expect(same.personas.map((p) => p.outcome)).toEqual(["skipped", "skipped"]); // all or none
    expect(getPerson(db, migratedPersonId("ws1", c.n.samA))).toBeNull();
    expect(getPerson(db, migratedPersonId("ws1", c.n.samB))).toBeNull();
  });

  it("migrates two notes with one name when the user names them apart, and the bare name stays ambiguous", () => {
    const r = apply({ personas: [{ noteId: c.n.samA, name: "Sam Whitfield (support)" }, { noteId: c.n.samB, name: "Sam Whitfield (sales)" }] });
    expect(r.personas.map((p) => p.outcome)).toEqual(["created", "created"]);
    const a = getPerson(db, migratedPersonId("ws1", c.n.samA))!;
    const b = getPerson(db, migratedPersonId("ws1", c.n.samB))!;
    expect([a.personaNoteId, b.personaNoteId]).toEqual([c.n.samA, c.n.samB]);
    expect(a.aliases).not.toContain("Sam Whitfield");
    expect(b.aliases).not.toContain("Sam Whitfield");
    // A meeting that says "Sam Whitfield" gets both as suggestions to settle, never one silently.
    db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at, version) VALUES ('m-sam', 'proj1', 'ws1', 'Sam sync', '**Attendees:** Sam Whitfield', '[]', '[]', '[]', 0, 'note', '', '2026-11-01', '2026-11-01', 0)").run();
    const m = apply({ meetings: ["m-sam"] });
    expect(m.meetings[0]).toMatchObject({ outcome: "captured", attendees: [] });
    expect([...m.meetings[0].suggested].sort()).toEqual([a.id, b.id].sort());
  });

  it("adds an accepted first-name alias, and drops one another person already answers to", () => {
    apply({ personas: [{ noteId: c.n.ana, aliases: ["Ana"] }, { noteId: c.n.ben, aliases: ["Ben"] }] });
    expect(getPerson(db, migratedPersonId("ws1", c.n.ana))!.aliases).toContain("Ana");
    // "Ana" is Ana's now; accepting it for Grace is dropped rather than made ambiguous.
    apply({ personas: [{ noteId: c.n.grace, aliases: ["Ana", "Gracie"] }] });
    expect(getPerson(db, migratedPersonId("ws1", c.n.grace))!.aliases).toEqual(["Gracie"]);
  });

  it("leaves a person the user dismissed or deleted alone", () => {
    apply({ personas: [{ noteId: c.n.ben }, { noteId: c.n.cleo }] });
    deletePerson(db, migratedPersonId("ws1", c.n.ben));
    updatePerson(db, migratedPersonId("ws1", c.n.cleo), { status: "dismissed" });
    const r = apply({ personas: [{ noteId: c.n.ben }, { noteId: c.n.cleo }] });
    expect(r.personas.map((p) => [p.outcome, p.reason])).toEqual([["skipped", "removed_by_user"], ["unchanged", "already_linked"]]);
    expect(getPerson(db, migratedPersonId("ws1", c.n.ben))).toBeNull();
    expect(getPerson(db, migratedPersonId("ws1", c.n.cleo))!.status).toBe("dismissed");
  });

  it("never links across workspaces", () => {
    apply(approveAll());
    expect(getPerson(db, c.people.otherAna)).toMatchObject({ workspaceId: "ws2" });
    expect(getPerson(db, c.people.otherAna)!.personaNoteId).toBeFalsy();
    expect(listPeople(db, "ws2").map((p) => p.name)).toEqual(["Ana Ruiz"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM people WHERE workspace_id = 'ws2'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_mentions m JOIN notes n ON n.id = m.note_id WHERE n.workspace_id = 'ws2'").get()).toEqual({ n: 0 });
  });
});

describe("apply: meetings, mentions and action items", () => {
  beforeEach(() => setPeopleEnabled(db, true));

  const attendeeNames = (noteKey: string) => {
    const meetingId = (db.prepare("SELECT meeting_id FROM notes WHERE id = ?").get(c.n[noteKey]) as { meeting_id: string | null }).meeting_id;
    return meetingId ? listAttendees(db, meetingId).map((a) => `${getPerson(db, a.personId)!.name}:${a.status}`).sort() : [];
  };

  it("attaches approved meetings to the people, as confirmed attendees on the right date", () => {
    const r = apply(approveAll());
    expect(attendeeNames("m1")).toEqual(["Ana Ruiz:confirmed", "Ben Okafor:confirmed"]);
    expect(attendeeNames("m2")).toEqual(["Ana Ruiz:confirmed", "Cleo Marsh:confirmed"]);
    expect(attendeeNames("m4")).toEqual(["Elena Fischer:confirmed", "Farid Haddad:confirmed"]); // "Fari" is Farid's alias
    expect(attendeeNames("m6")).toEqual(["Farid Haddad:confirmed", "Iris Novak:confirmed"]);
    const meetingOf = (k: string) => db.prepare("SELECT m.starts_at, m.source FROM meetings m JOIN notes n ON n.meeting_id = m.id WHERE n.id = ?").get(c.n[k]);
    expect(meetingOf("m1")).toEqual({ starts_at: "2026-11-03T00:00:00.000Z", source: "note" });
    expect(meetingOf("m2")).toEqual({ starts_at: "2026-11-05T00:00:00.000Z", source: "note" });
    expect(r.meetings.every((m) => m.outcome === "captured")).toBe(true);
  });

  it("never invents people: unknown names and a bare first name stay text", () => {
    const peopleBefore = db.prepare("SELECT COUNT(*) AS n FROM people").get();
    const r = apply(approveAll());
    // "Chris" matches neither Chris, "Unknown Guest" nobody; Grace attends m3, Dima (alias) and nobody else m5.
    expect(attendeeNames("m3")).toEqual(["Grace Lindqvist:confirmed"]);
    expect(r.meetings.find((m) => m.noteId === c.n.m3)!.unmatched).toEqual(["Chris"]);
    expect(attendeeNames("m5")).toEqual(["Dmitri Volkov:confirmed"]);
    expect(r.meetings.find((m) => m.noteId === c.n.m5)!.unmatched).toEqual(["Unknown Guest"]);
    const created = (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n - (peopleBefore as { n: number }).n;
    expect(created).toBe(r.personas.filter((p) => p.outcome === "created").length); // no stub people beyond the approved ones
    expect(db.prepare("SELECT COUNT(*) AS n FROM people WHERE id LIKE 'stub:%'").get()).toEqual({ n: 0 });
  });

  it("skips a meeting nobody known attends, and one nobody approved", () => {
    const r = apply({ meetings: [c.n.m3, c.n.prose, c.n.maria] });
    expect(r.meetings.map((m) => [m.outcome, m.reason])).toEqual([["skipped", "no_matching_attendees"], ["skipped", "not_a_candidate"], ["skipped", "not_a_candidate"]]);
    expect(attendeeNames("m1")).toEqual([]); // not approved, so the body pass never ran
  });

  it("makes a person's timeline: a meeting appears for each resolved attendee", () => {
    apply(approveAll());
    const timeline = (key: string) => (db.prepare(`
      SELECT n.title FROM meeting_attendees a JOIN notes n ON n.meeting_id = a.meeting_id
      WHERE a.person_id = ? AND a.deleted_at IS NULL AND a.status = 'confirmed' ORDER BY n.title
    `).all(migratedPersonId("ws1", c.n[key])) as { title: string }[]).map((r) => r.title);
    expect(timeline("ana")).toEqual(["Design review", "Sync with Ana and Ben"]);
    expect(timeline("farid")).toEqual(["Elena 1:1", "Retro"]);
  });

  it("creates mentions from wikilinks and resolves action-item owners, leaving team and bare first names unassigned", () => {
    const r = apply(approveAll());
    const ana = migratedPersonId("ws1", c.n.ana);
    expect(db.prepare("SELECT note_id FROM note_mentions WHERE person_id = ? AND deleted_at IS NULL").all(ana)).toEqual([{ note_id: c.n.m2 }]);
    const items = (personId: string) => db.prepare("SELECT text FROM note_action_items WHERE owner_person_id = ? ORDER BY text").all(personId).map((x) => (x as { text: string }).text);
    expect(items(migratedPersonId("ws1", c.n.grace))).toEqual(["regression suite"]); // [[Name]]: form
    expect(items(migratedPersonId("ws1", c.n.cleo))).toEqual(["icon audit"]);
    expect(items(migratedPersonId("ws1", c.n.chrisM))).toEqual(["mobile release notes"]);
    expect(items(migratedPersonId("ws1", c.n.chrisL))).toEqual(["platform migration"]);
    // Owner "Ana" (a first name) isn't an alias until accepted; "Team" never is.
    expect(items(ana)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_action_items WHERE owner_person_id IS NULL AND owner_text = 'Team'").get()).toEqual({ n: 2 });
    expect(r.index.ownedItemsAfter).toBeGreaterThan(r.index.ownedItemsBefore);
    expect(r.index.mentionsAfter).toBeGreaterThan(r.index.mentionsBefore);
  });

  it("an accepted first-name alias assigns the items written with it", () => {
    apply({ personas: [{ noteId: c.n.ana, aliases: ["Ana"] }, { noteId: c.n.ben, aliases: ["Ben"] }, { noteId: c.n.grace, aliases: ["Grace"] }] });
    const items = (key: string) => db.prepare("SELECT text FROM note_action_items WHERE owner_person_id = ? ORDER BY text").all(migratedPersonId("ws1", c.n[key])).map((x) => (x as { text: string }).text);
    expect(items("ana")).toEqual(["close the incident review", "draft the hiring plan", "ship the rollout plan"]);
    expect(items("ben")).toEqual(["fix flaky test", "review the API draft", "split the epic"]);
    expect(items("grace")).toEqual(["regression suite", "send the test report"]);
  });

  it("a person's open items are the unchecked owned lines across notes", () => {
    apply({ personas: [{ noteId: c.n.ana, aliases: ["Ana"] }] });
    const open = db.prepare("SELECT COUNT(*) AS n FROM note_action_items WHERE owner_person_id = ? AND done = 0").get(migratedPersonId("ws1", c.n.ana));
    expect(open).toEqual({ n: 2 });
  });
});

describe("apply: safety", () => {
  beforeEach(() => setPeopleEnabled(db, true));

  it("never changes a note: not the persona notes, not the meeting notes", () => {
    const notes = () => db.prepare("SELECT id, title, content, folder, tag_ids, archived_at, deleted_at, version, updated_at FROM notes ORDER BY id").all();
    const before = notes();
    apply(approveAll({ personas: withAnaAlias() }));
    expect(getPerson(db, migratedPersonId("ws1", c.n.ana))!.aliases).toContain("Ana");
    const after = notes() as Array<{ id: string; version: number }>;
    // Only the meeting link (and its bookkeeping) may differ on meeting notes; bodies, titles and folders never.
    const strip = (rows: unknown[]) => (rows as Array<Record<string, unknown>>).map(({ version: _v, updated_at: _u, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    expect(after.filter((n, i) => n.version !== (before[i] as { version: number }).version).every((n) => ["m1", "m2", "m3", "m4", "m5", "m6"].map((k) => c.n[k]).includes(n.id))).toBe(true);
  });

  it("deletes nothing: no tombstones and no removed rows", () => {
    const tombstones = () => TABLES.filter((t) => ["people", "meetings", "meeting_attendees", "note_mentions", "person_edges"].includes(t))
      .map((t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NOT NULL`).get() as { n: number }).n);
    apply(approveAll());
    expect(tombstones()).toEqual([0, 0, 0, 0, 0]);
    const people = (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n;
    apply(approveAll());
    expect((db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(people);
  });

  it("is idempotent: a second run reports no change and writes nothing", () => {
    const approvals = approveAll({ personas: withAnaAlias() });
    const first = apply(approvals);
    const afterFirst = snapshot();
    expect((afterFirst.sync_pending ?? []).length).toBeGreaterThan(0); // the capture triggers are live, so equality below means no sync churn
    const second = apply(approvals);
    expect(snapshot()).toEqual(afterFirst); // same rows, same timestamps, same sync queue
    expect(second.personas.every((p) => p.outcome === "unchanged" || p.outcome === "skipped")).toBe(true);
    expect(second.personas.filter((p) => p.outcome === "created" || p.outcome === "linked")).toEqual([]);
    expect(second.meetings.every((m) => m.outcome === "unchanged")).toBe(true);
    expect(first.personas.filter((p) => p.outcome === "created").length).toBeGreaterThan(8);
    // The migrated state is a fixed point of the normal indexing path too.
    indexNotePeople(db, "ws1", undefined, { bodyMeetings: false });
    expect(snapshot()).toEqual(afterFirst);
  });

  it("re-running the inventory on a migrated workspace shows nothing left to create", () => {
    apply(approveAll());
    const inv = inventory();
    const stillCreate = inv.personas.filter((p) => p.action === "create" && p.confidence !== "low").map((p) => p.name);
    expect(stillCreate).toEqual([]);
    expect(inv.personas.filter((p) => p.skipReason === "already_linked").length).toBeGreaterThan(8);
  });

  it("asks for the frontmatter refresh only for meeting notes that gained confirmed attendees, and never in a dry run", () => {
    const refresh = vi.fn((ids: string[]) => ({ written: ids, failed: [] as string[] }));
    apply(approveAll(), true, refresh);
    expect(refresh).not.toHaveBeenCalled();
    const r = apply(approveAll(), false, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(r.frontmatterNotes)).toEqual(new Set([c.n.m1, c.n.m2, c.n.m3, c.n.m4, c.n.m5, c.n.m6]));
  });

  it("touches no files without a refresh callback", () => {
    const r = apply(approveAll());
    expect(r.frontmatterNotes).toEqual([]);
  });
});
