# Mobile People: tab, teams and team editing

Status: draft for review (2026-11-20). Follow-up to the desktop People/Teams
work in PR #332; see `people-layer.md` for the data model and rules.

## Goal

Bring the phone to parity with desktop where parity makes sense on a phone:
People as a first-class tab, the same groupings, Teams with editing, and the
person-page actions that came with teams (teams, merge, former relationships).
The desktop's wide pictures wait for a second PR and only the ones that fit
a phone.

## Where mobile is today

- `PeopleScreen` (list by relationship + suggestions + search) and
  `PersonScreen` (relationship, cadence, profile, open items, timeline),
  reached by a pushed `app/people` route, not a tab.
- The data layer is ready: migration v14 created `team_memberships` and `kind`;
  `shared/people/*` (queries, team-queries, merge, chip-edges, list-groups,
  teams, rhythm, zones) runs on the phone through `createExpoSyncDb`; the
  mobile `people` agent tool already has teams, merge and archive.
- Missing in the UI: teams, the grouping picker, "You" pinned first, team
  chips on a person, merging duplicates, former relationships.

## Tab bar

Today: Projects, Calendar, Graph, Chat, Search (`role="search"`). iOS shows
five tabs and folds the rest into "More". Plan: add **People** after Calendar
(`sf="person.2.fill"`, `md="group"`), then check on the simulator whether the
search-role tab counts toward the five.

- If Search is drawn apart from the bar (iOS 26 style) and doesn't count: five
  tabs, done.
- If it counts: Graph is the least-used and drops into "More", or moves into
  Projects as a view. Decide after seeing it, not before.

Routes: move `app/people/{index,[id]}.tsx` into `app/(tabs)/people/` with its
own `_layout.tsx` stack (like the other tabs) and add `team/[id].tsx`. Route
groups don't change URLs, so every existing `router.push("/people/[id]")` (chat
mentions, Today, notes) keeps working. Remove the two `Stack.Screen` entries in
`app/_layout.tsx`.

## PR 1: tab, list, Teams, team editing

Order of work, one commit per step:

1. **Tab and routes** (above).
2. **List parity.** Top switcher People | Teams (the shared `SegmentedControl`;
   more entries join it in PR 2). A grouping menu (relationship, team,
   location with local time, last met, name) on `groupPeopleBy`, remembered per
   device; "You" pinned first. This is almost free: the grouping is shared.
3. **DB wrappers** in `src/db/people.ts`: `loadTeams`, `loadMemberships`, and
   write wrappers for create/update/delete team, merge teams, add/end member,
   merge people, each through the existing `write()` so `notifyLocalWrite`
   fires. Confirm whether the desktop-only extras of `mergePeople` (checklist
   owners, profile cache, meeting frontmatter) have mobile equivalents; if the
   phone keeps none of them in tables, nothing to port.
4. **Teams list.** Nested by `teamForest`, kind badge, member avatars/count,
   "Without a team" at the end, New team. Rows open the team page.
5. **Team page** (`team/[id]`). Reads: description, lead, parent breadcrumb
   (by id, as desktop), channel, links, members with roles, past members,
   duplicate-name banner. Editing follows `PersonScreen`'s pattern (an Edit
   button, a `BottomSheet`, an explicit Save), not autosave-on-blur:
   details (name, kind, description, channel), lead and parent pickers, links
   (one list edited and saved whole, so no overlapping saves), add/remove
   member, per-member role, merge into, delete with confirm.
6. **Person page.** Teams section (chips with remove, "Add to a team" picker,
   "Move to a new team"), "Before:" line, "Same as…" on a suggestion and
   Duplicate in the details sheet (merge with confirm), former relationships
   shown as such.

Already done in this branch: `PersonScreen`'s details sheet now catches a
refused team save (a guild or project name) instead of crashing.

## PR 2: pictures that suit a phone

In order: **Rhythm** (a list with bars, a natural fit), **Time zones** (a
vertical day strip), **Org chart** as a collapsible indented tree, **Map**
(flat, Skia/SVG, no globe). Skip Relationships and Bridges (force canvases,
desktop-sized). Each joins the top switcher. Pure helpers (`rhythm`, `zones`,
`sun`, `buildOrgChart`) are shared; `buildOrgChart` still lives in
`src/` and moves to `shared/` first (it is on the "Later" list in
`people-layer.md`).

## Testing

- Unit: DB wrappers against better-sqlite3, like `db/people.test.ts`.
- Device-only risk: the phone's adapter nests transactions as savepoints at
  runtime but not inside migrations. `mergeTeams`, `team_upsert` and
  `mergePeople` use `db.transaction`; extend `expo-sync-db.test.ts` to cover a
  nested transaction through the adapter, then try a team merge on the
  simulator.
- Simulator pass (`control` tool): tab bar overflow, Dynamic Type, dark mode,
  keyboard over sheets, iPad/Duo layout (follow `iphone-duo.md`; a split view
  for list | page is a later nicety).

## Release hygiene

- No migration or sync-protocol change (v14 and protocol 7 already ship in #332).
- Mobile changelog: the pending `mobile/changelogs/v0.1.22.md`; never bump the
  version. Use `.github/PULL_REQUEST_TEMPLATE/mobile.md`.
- Keep mobile out of the marketing site until the app ships.
- Land after #332 merges (it depends on v14 and the shared code), or stack on
  it and retarget.

## Open questions

- Tab overflow outcome (above).
- One PR or two? Steps 1–3 and 6 are small; steps 4–5 (Teams and the team
  editor) are the bulk. If review load matters, split there: 1a = tab, list,
  person page; 1b = Teams and editing.

## Findings from PR 1 (to solve)

Tried on the iPhone Duo (closed and open poses) and the iPhone simulator.

- **Tab bar:** six tabs overflow into More on iPhone. Order is now Projects,
  Calendar, People, Chat, Graph, Search, so Graph folds into More and Chat
  stays. On the Duo the vertical rail shows all six with no More.
- **Sheet "Done" hidden on the Duo closed screen (open, shared bug):** the
  clock/status pill covers the top-right of the screen, so `BottomSheetHeader`'s
  Done button sits under it. Affects every sheet, not only People. Fix in
  `BottomSheetHeader`/`BottomSheet` with the fold/rail insets (`useFold()`).
- **Open pose is full width:** the list and team page stretch across the inner
  screen. Belongs to `mobile-wide-layouts.md` (list | page split).
- **Not hand-tested:** person page on the Duo, members sheet, new-team sheet,
  Same as... / Duplicate merge flow, keyboard over sheets, Dynamic Type, iPad.
- **Merge extras:** the device-local extras of the desktop `mergePeople` have no
  mobile equivalent, so nothing was ported.
