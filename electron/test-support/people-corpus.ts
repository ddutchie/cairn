/**
 * A synthetic corpus in the shape of the People pilot (the Nov 18 work
 * workspace: ~15 persona notes, 6 meeting notes, ~20 owned checklist items),
 * plus the tricky cases the migration must survive. Every name here is made
 * up; none is a real colleague. Used by the migration tests
 * (`electron/db/people-migration.test.ts`); not user data.
 *
 * Workspace `ws1` / project `proj1` is the one under test. `ws2` holds an
 * unrelated "Ana Ruiz" persona, to prove nothing crosses workspaces.
 */

import type Database from "better-sqlite3";
import type { NoteFrontmatterHints } from "../../shared/people/inventory";
import { createNote } from "../db/notes-queries";
import { createTag } from "../db/tags-queries";
import { createPerson } from "../db/people-queries";
import { createProject, createWorkspace } from "../db/workspace-queries";

export interface PeopleCorpus {
  /** Note ids by short key, e.g. `ana`, `samA`, `m1`. */
  n: Record<string, string>;
  /** Frontmatter the files would carry (the DB doesn't store these keys). */
  frontmatter: Map<string, NoteFrontmatterHints>;
  readFrontmatter: (noteId: string) => NoteFrontmatterHints | null;
  /** People that exist before the migration, by key. */
  people: Record<string, string>;
}

const hints = (over: Partial<NoteFrontmatterHints> = {}): NoteFrontmatterHints => ({
  tags: [], aliases: [], emails: [], hasAttendees: false, attendees: undefined, date: undefined, ...over,
});

/** Builds the corpus into a db that already has `ws1` and `proj1` (see `seedWorkspace`/`seedProject`). */
export function seedPeopleCorpus(db: Database.Database): PeopleCorpus {
  const n: Record<string, string> = {};
  const frontmatter = new Map<string, NoteFrontmatterHints>();
  const personTag = createTag(db, { id: "tag-person", workspaceId: "ws1", name: "person", color: "#888888" });

  const add = (key: string, title: string, folder: string, content = "", extra: { tagIds?: string[]; fm?: Partial<NoteFrontmatterHints> } = {}) => {
    const id = `n-${key}`;
    createNote(db, { id, projectId: "proj1", workspaceId: "ws1", title, content, folder, tagIds: extra.tagIds });
    n[key] = id;
    if (extra.fm) frontmatter.set(id, hints(extra.fm));
    return id;
  };

  // ── Persona notes ─────────────────────────────────────────────
  add("ana", "Ana Ruiz", "People", "Engineering manager.\n", { tagIds: [personTag.id] });
  add("ben", "Ben Okafor", "People", "Backend.\n");
  add("cleo", "Cleo Marsh", "Discussions/Cleo Marsh", "Design lead.\n");
  add("dima", "Dmitri Volkov (Dima)", "People", "Data.\n");
  add("elena", "Persona - Elena Fischer", "", "Product.\n", { tagIds: [personTag.id] });
  add("farid", "Farid Haddad", "People", "Email: f.haddad@example.com\nSRE.\n", { fm: { aliases: ["Fari"], emails: ["f.haddad@example.com"] } });
  add("grace", "Grace Lindqvist", "People", "QA.\n", { tagIds: [personTag.id] });
  add("chrisM", "Chris Moreau", "People", "Mobile.\n");
  add("chrisL", "Chris Lang", "People", "Platform.\n");
  // Two notes for the same name: neither migrates by itself.
  add("samA", "Sam Whitfield", "People", "Sam, support.\n");
  add("samB", "Sam Whitfield", "Discussions/Sam Whitfield", "Sam, sales.\n");
  add("hana", "Hana Sato", "People", "Former colleague.\n");
  add("iris", "Iris Novak", "People", "Security.\n");
  // Matches an existing person by email, not by name.
  add("jonas", "Jonas Weber", "People", "**Email:** jonas@example.com\nFinance.\n");
  add("kira", "Kira Tanaka", "People", "Deleted note.\n");
  // A topic note in a People folder: a weak guess, shown as low confidence.
  add("pipeline", "Hiring Pipeline Overview", "People", "Roles open.\n");
  // Named like a person, nothing says it is one.
  add("maria", "Maria Garcia", "Reading list", "A book.\n");
  add("quarterly", "Quarterly Review", "Notes", "Numbers.\n");
  // A person in another workspace is not this workspace's business (below).

  // ── Meeting notes ─────────────────────────────────────────────
  add("m1", "Sync with Ana and Ben", "Meetings",
    "**Attendees:** Ana Ruiz, Ben Okafor\n**When:** 2026-11-03\n\n- [ ] **Ana** - ship the rollout plan\n- [ ] [[Ben Okafor]]: review the API draft\n- [x] @Grace to send the test report\n");
  add("m2", "Design review", "Meetings",
    "Notes from the review. See [[Ana Ruiz]].\n\n- [ ] **Cleo** - update the mocks\n",
    { fm: { hasAttendees: true, attendees: ["[[Ana Ruiz]]", "[[Cleo Marsh]]"], date: new Date("2026-11-05T00:00:00Z") } });
  add("m3", "Hiring debrief", "Meetings",
    "**Attendees:** Chris, Grace Lindqvist\n**When:** 2026-11-06\n\n- [ ] **Chris** - send the offer\n- [ ] **Team** - agree the rubric\n- [ ] follow up with recruiting\n");
  add("m4", "Elena 1:1", "Meetings", "Agenda.\n\n- [ ] **Dima** - draft the data contract\n",
    { fm: { hasAttendees: true, attendees: "Elena Fischer, Fari", date: "2026-11-07" } });
  add("m5", "Planning", "Meetings",
    "**Attendees:** Dima, Unknown Guest\n**When:** 2026-11-08\n\n- [ ] **Ben** - split the epic\n",
    { fm: { hasAttendees: true, attendees: ["Dima", "Unknown Guest"], date: "2026-11-08" } });
  add("m6", "Retro", "Meetings", "- Attendees: Farid Haddad and Iris Novak\n- Date: 2026-11-10\n\n- [ ] **Iris** - rotate the keys\n- [ ] [[Farid Haddad]]: tune the alerts\n");

  add("actions", "Action items", "Notes",
    "- [ ] **Ana** - draft the hiring plan\n- [x] **Ana** - close the incident review\n- [ ] [[Grace Lindqvist]]: regression suite\n"
    + "- [ ] [[Cleo Marsh]] - icon audit\n- [ ] @Ben to fix flaky test\n- [ ] **Farid** - on-call handover\n"
    + "- [ ] **Chris Moreau** - mobile release notes\n- [ ] **Chris Lang** - platform migration\n- [ ] **Team** - retro actions\n");

  // ── Look like meetings, aren't ────────────────────────────────
  add("prose", "Product thoughts", "Notes",
    "When we met the team last month it went well.\nParticipants: users, admins\nAttendees were late again.\n\n```\n**Attendees:** Ana Ruiz, Ben Okafor\n- [ ] **Ana** - inside a code block\n```\n");
  add("journal", "Journal 2026-11-01", "Journal", "Quiet day.\n", { fm: { date: "2026-11-01" } });
  add("plain", "Shopping", "Notes", "- [ ] milk\n- [ ] **bread** is not a person but looks owned\n");

  // ── State: archived, deleted ──────────────────────────────────
  db.prepare("UPDATE notes SET archived_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", n.hana);
  db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", n.kira);

  // ── Another workspace with the same names ─────────────────────
  createWorkspace(db, { id: "ws2", name: "Other Workspace" });
  createProject(db, { id: "proj2", workspaceId: "ws2", name: "Other Project" });
  createNote(db, { id: "n-other-ana", projectId: "proj2", workspaceId: "ws2", title: "Ana Ruiz", content: "Someone else.\n", folder: "People" });
  n.otherAna = "n-other-ana";

  // ── People that already exist ─────────────────────────────────
  const people: Record<string, string> = {};
  people.iris = createPerson(db, { workspaceId: "ws1", name: "Iris Novak", status: "suggested", provenance: "inferred" }).id;
  people.jw = createPerson(db, { workspaceId: "ws1", name: "J. Weber", emails: ["jonas@example.com"] }).id;
  people.otherAna = createPerson(db, { workspaceId: "ws2", name: "Ana Ruiz" }).id;

  return { n, frontmatter, readFrontmatter: (id) => frontmatter.get(id) ?? null, people };
}
