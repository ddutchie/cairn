/**
 * Cairn — People layer data for the marketing screenshots (flag on).
 *
 * Opt-in (`buildScreenshotMock({ people: true })`) so every other screenshot and
 * perf test keeps the flag-off fixture. Everything is relative to the real
 * current date, like the card due dates, so "met 6 days ago" and "next 1:1
 * tomorrow" read right whenever the images are regenerated. Names are invented.
 */
import type { Meeting, Person, PersonEdge, Relationship } from "../../shared/types/people";
import type { PeopleNetwork, PersonPage, PersonSummary, PersonTimelineItem } from "../../shared/types/people-view";
import type { PersonProfile, PrepBrief } from "../../shared/people/oneonone";

const WS = "ws-cairn-hq";
const DAY = 86_400_000;

export interface PeopleFixture {
  people: PersonSummary[];
  suggestions: PersonSummary[];
  pages: Record<string, PersonPage>;
  network: PeopleNetwork;
  profiles: Record<string, PersonProfile>;
  /** The person whose page the screenshots open, and the brief on it. */
  featuredId: string;
  brief: PrepBrief;
}

const rel = (type: Relationship["type"], label?: string): Relationship => ({ type, ...(label ? { label } : {}), provenance: "explicit" });

export function buildPeopleFixture(now: Date = new Date()): PeopleFixture {
  const at = (days: number, hour = 10): string => {
    const d = new Date(now.getTime() + days * DAY);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const created = at(-120);

  const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
    id, workspaceId: WS, name, aliases: [], emails: [`${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`],
    relationship: [], status: "confirmed", provenance: "explicit", isMe: false, agentPrivate: false,
    createdAt: created, updatedAt: created, ...extra,
  });
  const summary = (p: Person, last?: number, next?: number): PersonSummary => ({
    ...p, ...(last !== undefined ? { lastMetAt: at(last, 14) } : {}), ...(next !== undefined ? { nextMeetingAt: at(next, 15) } : {}),
  });

  const me = person("per-me", "Alex Morgan", { title: "Engineering Manager", team: "Sync", location: "Toronto, Canada", timezone: "America/Toronto", isMe: true, aliases: ["Alex"] });
  const priya = person("per-priya", "Priya Raman", { title: "Director of Engineering", team: "Platform", location: "London, UK", timezone: "Europe/London", relationship: [rel("manager")], cadence: "biweekly" });
  const ana = person("per-ana", "Ana Lopez", { title: "Senior Engineer", team: "Sync", location: "Madrid, Spain", timezone: "Europe/Madrid", relationship: [rel("direct_report")], cadence: "weekly", aliases: ["Ana"], personaNoteId: "note-persona-ana", slackId: "U0ANA" });
  const ben = person("per-ben", "Ben Okafor", { title: "Software Engineer", team: "Sync", location: "Lagos, Nigeria", timezone: "Africa/Lagos", relationship: [rel("direct_report")], cadence: "biweekly", personaNoteId: "note-persona-ben" });
  const chloe = person("per-chloe", "Chloe Martin", { title: "Software Engineer", team: "Sync", location: "Vancouver, Canada", timezone: "America/Vancouver", relationship: [rel("direct_report", "onboarding")], cadence: "weekly" });
  const diego = person("per-diego", "Diego Santos", { title: "Staff Engineer", team: "Platform", location: "Mexico City, Mexico", timezone: "America/Mexico_City", relationship: [rel("peer")] });
  const mei = person("per-mei", "Mei Tanaka", { title: "Design Lead", team: "Design", location: "Tokyo, Japan", timezone: "Asia/Tokyo", relationship: [rel("peer")] });
  const hannah = person("per-hannah", "Hannah Weber", { title: "VP Product", team: "Product", location: "Berlin, Germany", timezone: "Europe/Berlin", relationship: [rel("stakeholder", "VP Product")], cadence: "monthly" });
  const samir = person("per-samir", "Samir Patel", { relationship: [rel("mentor")], cadence: "monthly" });
  const jonas = person("per-jonas", "Jonas Eriksen", { relationship: [rel("candidate")], stage: "Final interview" });
  const tom = person("per-tom", "Tom Reyes", { status: "suggested", provenance: "inferred" });

  const people: PersonSummary[] = [
    summary(me),
    summary(ana, -6, 1), summary(ben, -9, 4), summary(chloe, -3, 2),
    summary(priya, -12, 2), summary(diego, -5), summary(mei, -20), summary(hannah, -30, 9),
    summary(samir, -25, 14), summary(jonas, -2, 5),
  ];
  const suggestions: PersonSummary[] = [summary(tom, -1)];

  const edge = (id: string, source: Person, target: Person, type: PersonEdge["type"], label?: string): PersonEdge => ({
    id, workspaceId: WS, sourceId: source.id, targetId: target.id, type, ...(label ? { label } : {}),
    status: "confirmed", provenance: "explicit", createdAt: created, updatedAt: created,
  });
  const edges: PersonEdge[] = [
    edge("e1", priya, me, "manager_of"), edge("e2", me, ana, "manager_of"), edge("e3", me, ben, "manager_of"), edge("e4", me, chloe, "manager_of"),
    edge("e5", samir, me, "mentor_of"), edge("e6", hannah, me, "stakeholder_of"), edge("e7", ben, chloe, "buddy_of", "onboarding buddy"),
    edge("e8", diego, mei, "partner"),
  ];
  const co = (a: Person, b: Person, meetings: number) => ({ a: a.id, b: b.id, meetings });
  const network: PeopleNetwork = {
    edges,
    coAttendance: [co(me, ana, 14), co(me, ben, 9), co(me, chloe, 8), co(ana, ben, 6), co(ben, chloe, 5), co(ana, chloe, 4), co(me, priya, 6), co(me, diego, 5), co(diego, mei, 4), co(me, hannah, 3), co(priya, hannah, 3)],
  };

  const meeting = (id: string, title: string, days: number): Meeting => ({
    id, workspaceId: WS, title, startsAt: at(days, 14), source: "calendar", seriesKey: "ana-1-1", createdAt: created, updatedAt: created,
  });
  const noteRef = (id: string, title: string, days: number) => ({ id, projectId: "proj-cairn-core", title, updatedAt: at(days, 15) });
  const timeline: PersonTimelineItem[] = [
    { kind: "meeting", at: at(1, 15), meeting: { ...meeting("mtg-ana-next", "1:1 Alex / Ana", 1), startsAt: at(1, 15) }, notes: [], with: [] },
    { kind: "meeting", at: at(-6, 14), meeting: meeting("mtg-ana-3", "1:1 Alex / Ana", -6), notes: [noteRef("note-research", "1:1 Ana — sync engine scope", -6)], with: [] },
    { kind: "card", at: at(-8), card: { id: "card-2", projectId: "proj-cairn-core", title: "Conflict resolution UI", columnName: "In Progress", done: false, updatedAt: at(-8) } },
    { kind: "meeting", at: at(-13, 14), meeting: meeting("mtg-ana-2", "1:1 Alex / Ana", -13), notes: [noteRef("note-sync", "1:1 Ana — promotion case", -13)], with: [] },
    { kind: "mention", at: at(-15), note: noteRef("note-roadmap", "Roadmap 2026", -15) },
    { kind: "meeting", at: at(-20, 14), meeting: meeting("mtg-ana-1", "Sync engine design review", -20), notes: [noteRef("note-sync", "Sync Engine RFC", -20)], with: [{ personId: ben.id, name: ben.name }, { personId: diego.id, name: diego.name }] },
    { kind: "card", at: at(-24), card: { id: "card-22", projectId: "proj-cairn-core", title: "Write the offline storage migration", columnName: "Done", done: true, updatedAt: at(-24) } },
  ];
  const rv = (id: string, otherName: string, otherId: string, role: PersonPage["relations"][number]["role"], e: PersonEdge) => ({ edge: e, role, otherId, otherName });
  const pageOf = (p: Person, extra: Partial<PersonPage> = {}): PersonPage => ({ person: p, relations: [], timeline: [], persona: null, ...extra });

  const persona = {
    id: "note-persona-ana", projectId: "proj-cairn-core", title: "Ana Lopez",
    content: "# Ana Lopez\n\nSenior engineer on the sync engine. Wants to grow into a tech lead role.\n\n## Working with Ana\n- Likes written context before a meeting\n- Strongest on conflict resolution and offline behaviour\n\n## Goals\n- Lead the conflict-resolution UI end to end\n- Mentor Chloe through onboarding\n",
  };
  const pages: Record<string, PersonPage> = {
    [ana.id]: pageOf(ana, {
      relations: [rv("r1", me.name, me.id, "reports_to", edges[1])],
      timeline, persona, lastMetAt: at(-6, 14), nextMeetingAt: at(1, 15),
    }),
  };
  for (const p of [...people, ...suggestions]) if (!pages[p.id]) pages[p.id] = pageOf(p, { lastMetAt: p.lastMetAt, nextMeetingAt: p.nextMeetingAt });

  const profiles: Record<string, PersonProfile> = {
    [ana.id]: { fields: { title: "Senior Engineer, Sync", timezone: "Europe/Madrid", pronouns: "she/her", statusEmoji: "🎧", statusText: "Heads down until 3" }, fetchedAt: at(0, 9), stale: false },
  };
  const brief: PrepBrief = {
    version: 1, status: "ready", personId: ana.id, personName: ana.name, date: at(1).slice(0, 10), generatedAt: at(0, 9),
    meetingId: "mtg-ana-next", meetingTitle: "1:1 Alex / Ana", meetingStartsAt: at(1, 15),
    summary: "Ana is closing out the conflict-resolution UI and asked last time about taking the tech lead path on sync. The promotion case you drafted together is still open.",
    recent: [
      { text: "Shipped the merge preview for conflicting note edits and asked for review in #sync", source: "Slack" },
      { text: "Opened the PR for the offline storage migration", source: "GitHub" },
    ],
    followUps: ["Send Ana the promotion case outline you promised last week", "Check whether the conflict UI needs design time before the release"],
    questions: ["What would make the tech lead role feel worth taking on now?", "Where is the sync work blocked on someone else?"],
    sources: [{ name: "Notes", status: "ok" }, { name: "Slack", status: "ok" }, { name: "GitHub", status: "ok" }],
  };
  return { people, suggestions, pages, network, profiles, featuredId: ana.id, brief };
}
