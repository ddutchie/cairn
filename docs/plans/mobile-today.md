# Mobile Today

Status: proposal, 2026-11-22. Nothing built. Biggest desktop/mobile parity gap (`docs/plans/mobile-desktop-parity.md`).

## What desktop has

One brief per workspace, written by the built-in **Today automation** (`electron/lib/today.ts`): a headline, stat tiles, the day strip (events, free time first), three lanes (Need you as decisions, Prepared for you, Moving without you) and Your projects (facts Cairn computes itself, `electron/lib/today-facts.ts`). Marks (done items, edited drafts) and a history of earlier briefs sit next to it. The chat tool `get_today` returns a digest (`shared/today/digest.ts`). The brief and its pure helpers (`shared/today/*`: types, `dayBlocks`, history, digest, brief-edit) are already renderer- and mobile-safe.

## The finding that changes the plan

The earlier parity row says "the data already syncs". **The brief does not.** It is a JSON file under the automation's output folder inside the workspace (`today-files.ts`: `<automation out>/today/<date>.json`, plus `<date>.marks.json` and `history/`). Mobile syncs database rows through the oplog and attachment blobs from the shared iCloud folder; there is no automations table or Today file on the phone. The Today automation also needs the desktop's agent engine and connectors (calendar, mail, chat apps), which the phone does not have. So the phone cannot *generate* a brief, and today it cannot even *read* one.

What the phone does have locally: projects, tasks with due dates and columns, notes, tags, people with rhythm and open items, meetings and calendar events, widgets that already compute "due today / overdue".

## Options

| | What | Needs | Gives |
|---|---|---|---|
| A. Local Today | A screen built from synced data only: due and overdue tasks, today's meetings and day strip, people due to meet, open action items, recent notes, per-project facts | Mobile only. Port the fact computation (`today-facts.ts`) to a shared pure function | Works offline and without desktop; no AI "Need you / Prepared" lanes |
| B. Synced brief | Read the desktop's brief on the phone, marks written back | Desktop change: publish `today/*.json` (a synced table or a file the phone can read from the shared folder), plus a transport for marks | The real thing, identical to desktop; only as fresh as the last desktop run |
| C. A then B | Ship A now as the phone's own Today; add B as a richer "Brief" section when published | Both, in order | Value early, parity later |

## Recommendation: C, starting with A

1. **A first.** It has no desktop dependency, reuses data and widgets' counting that already exist, and fits the phone ("what needs me today"). Name it Today, same as desktop, and keep the sections it can really back.
2. **B second**, behind a decision on transport. Cheapest: a synced `today_briefs` row per day (JSON in a column, last-writer-wins, marks as a second column or row) so it rides the oplog the phone already trusts. A file read from the iCloud folder would work like attachments but adds a second sync path for text data.

## Where it lives (decision for the owner)

- **First tab.** Today replaces Projects as the launch tab; Projects stays one tap away. Strongest "home screen" feel; changes the launch flow and the tab count (five tabs already; NativeTabs would need Today to displace one, so Search or Calendar would have to move into Workspace).
- **Top of Projects** *(recommended)*. A Today card stack above the project list, tappable into a full `today` screen inside the Projects stack. No new tab, no launch change, Workspace keeps the tools. Cheap to move later.
- Widgets, quick actions and a `cairn://today` link should open it either way.

## Scope for the first PR (A, on the Projects tab)

1. Shared: `shared/today/` gets a pure `localTodayFacts(...)` (or reuse `projectFacts` if it is already DB-agnostic; `today-facts.ts` takes a better-sqlite3 handle, so port the queries to mobile's `getDb` and keep the shaping pure and shared).
2. Mobile queries: due today / overdue tasks, today's meetings/events, people due (`RhythmList` already computes), open action items.
3. Screen `app/(tabs)/(projects)/projects/today.tsx` plus a compact card at the top of Projects; use `TabScreen`, theme tokens, `ModalSafeView` not needed (tab screen).
4. `get_today` chat tool on mobile returning the same digest shape from the local facts (so the tool exists and chat can answer "what's on today" even before B).
5. Tests for the fact shaping; changelog; update the parity matrix (Today: Partial).

## Open questions

- Where it lives (above). 
- Should A's "Need you" be a heuristic (overdue + due today + blocked + unanswered action items) or omitted until B?
- B transport: synced row vs iCloud file; does desktop write the day's brief fast enough for the phone to show it in the morning (it runs unattended before work, so yes when the desktop is awake)?
- Marks: written from the phone? If yes they must sync back, which pushes B toward a row.
