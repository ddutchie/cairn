# The Workspace — idle office view of the live workspace

Status: phases 1–4 built on `feat/the-workspace` (2026-11-25): the office, live changes, the agent robot, and the week wall. The rest is planned.

## Idea

A pixel office that *is* the open workspace. It isn't a game played on the side. Each project is a room, each task and note is an object on a desk, and the people working on them (you, the assignees, the agent) walk between desks. Nothing in the office is invented: if the board changes, the office changes. When you chat with the agent and it moves a task to Done or edits a note, you see that happen in the room.

Reference points: Game Dev Story / Game Dev Tycoon (rooms, staff at desks, small speech bubbles), Two Point (ambient life). Unlike them, the economy here is not simulated. The workspace is the state, and the office only renders it and adds idle life.

It is an **idle view**: it plays fine left alone on a second monitor or a docked phone. It gets "a little bit more interactive" by letting a click open the real thing.

## Principles

1. **Read-only mirror, write through the app.** The sim never writes workspace data. Clicks open the real editor (sidebar / peek / sheet). The only persisted game state is cosmetic (desk layout, decor, the camera).
2. **Every visible change has a cause in the data.** Ambient motion (walking, coffee) is free; anything that *signals* (a sparkle on a desk, a card flying to Done) must come from an event.
3. **Shared sim, two hosts.** Same split as the arcade: `shared/arcade/workspace/{sim,render,layout,events}.ts`, with hosts in `ArcadeView` (desktop) and `PixelGameView` (mobile). No DB or IPC in `shared/`.
4. **Calm by default.** Event bursts (a 40-task agent import) are coalesced; at most a few animations at once; respects reduced motion.

## What maps to what

Revised 2026-11-25. The first draft had a room per project; one room per workspace with a desk per project reads better and leaves room for detail. Everything is drawn in stacked voxels with shading and shadows, like Task Force and Wayfinder.

| Workspace | Office |
|---|---|
| Workspace | The room. Its back wall has windows (daylight follows the clock), a wall clock and a "done this week" board |
| Project | A desk. The paper pile grows with open tasks, the book pile with notes, a red tab means an overdue card, and the front edge is in the project colour |
| Assignee | A person who sits at the desk where they have the most cards in progress. A second person stands beside it. Their look is stable, hashed from the name |
| Unassigned work in progress | The contractor, in hi-vis |
| Somebody working | A lit monitor, glowing after dark |
| Opened desk | That project from above: its board as cork trays of pinned cards, or its notes as a ruled page |
| The agent (chat/coding session) | A small robot that walks to whatever its tool calls touch (phase 3) |
| Calendar events / due dates | Calendar mode (phase 4) |

Desk order and the floor layout are deterministic (`layout.ts`), so the office looks the same across sessions. A small workspace gets its desks at 3×; a big one at 2×, with pages.

## Eventing

This is the core of the request. The app already has the three streams we need. The plan adds one small typed adapter in front of them.

### Sources (existing)

1. **Change feed** (`db:changes:get`, renderer `src/store/change-feed.ts`): every insert/update/delete on cards, notes, columns, projects, tags, by whatever process made it (renderer, `cairn-mcp`, sync, file watcher). `onChangeFeed` gives `touched` / `externalTouched`; the underlying `ChangeSet` has per-entity `upserts` and `removed`. This is the ground truth. It catches agent edits *and* edits from Claude Code via MCP, mobile sync, etc.
2. **Agent session stream** (`session:event`): tool calls as they start and finish. Replayed tool calls already carry `cairnRef { type: "note" | "task", id, title }`. This gives us *who* (the agent) and *intent before commit* (the robot can start walking to the desk when the tool call starts, and land the change when the feed confirms it).
3. **Note AI writes** (`note:aiWriteStarted` / `note:aiWriteEnded`): a long-running "typing" state on a book.

### Adapter: `WorkspaceEvent`

A pure function in `shared/arcade/workspace/events.ts` turns a before/after diff into typed events; a host-side bridge feeds it.

```ts
type Actor = "you" | "agent" | "external";   // external = MCP/sync/other window

type WorkspaceEvent =
  | { k: "task.created";  id: string; projectId: string; columnId: string; actor: Actor }
  | { k: "task.moved";    id: string; projectId: string; from: string; to: string; actor: Actor }
  | { k: "task.done";     id: string; projectId: string; actor: Actor }        // moved into a done column
  | { k: "task.updated";  id: string; projectId: string; fields: string[]; actor: Actor }
  | { k: "task.removed";  id: string; projectId: string; actor: Actor }
  | { k: "note.created" | "note.updated" | "note.removed"; id: string; projectId: string; actor: Actor }
  | { k: "note.writing";  id: string; on: boolean }                          // AI write start/end
  | { k: "agent.intent";  ref: { type: "note" | "task"; id: string }; tool: string } // tool call started
  | { k: "agent.idle" }
  | { k: "project.changed"; id: string };
```

- **Diffing**: the bridge keeps the last snapshot of the slice the office renders (cards by id with `columnId/assignee/priority/due`, notes by id with `updatedAt`). On each feed event it reads the new values from the store (already updated by the feed) and calls `diffWorkspace(prev, next) → WorkspaceEvent[]`. Pure, so it is unit-tested in `shared/`.
- **Attribution**: `own` changes → `you`; `externalTouched` within ~2 s of an `agent.intent` for the same id → `agent`; otherwise `external`. Good enough for animation. It is not an audit log.
- **Coalescing**: more than N events per project in one tick become one "flurry" (papers fly, counter ticks up) instead of N animations.
- **Reset**: a `reset` from the feed (cursor lost) rebuilds the office silently, with no animations.

### Desktop bridge

`src/components/arcade/workspace-bridge.ts`:
- subscribes `onChangeFeed` + the store selectors for cards/notes/columns of the active workspace;
- subscribes `session:event` through the existing engine client (only `tool/start`/`tool/result` with a `cairnRef`);
- subscribes `note:aiWrite*` push events;
- pushes `WorkspaceEvent`s into `sim.ingest(events)`.

No new IPC channel is needed for phase 1. (If phase 3 needs history, "what happened while I was away", add a read-only `db:changes:recent` and extend both test mocks per the parity rule.)

### Mobile bridge

Mobile has no agent session stream and no Electron feed. It uses the sync engine's applied-changes callback (or a SQLite poll of `updated_at` on the open projects every few seconds while the view is open) and runs the same `diffWorkspace`. All mobile actors are `you` or `external`; agent edits arrive via sync and show as `external`, unless the synced row carries a source marker (see open questions).

## Interaction

| Gesture | Result |
|---|---|
| Click a desk | Opens the project from above: board or notes tab (B / N), ← → for the next desk, Esc back |
| Click a card or note | Opens it in the side preview pane (`PreviewPane`, as chat's centre mode uses), with the office still in view |
| Click a person | A bubble of their cards in progress; click one to open it |
| Click the robot | Opens the agent chat that is driving it (phase 3) |
| Drag (stretch goal) | Drag a card between trays on an opened desk = `moveCard`, through the normal store action. The only write, and opt-in |

Touch copy follows the arcade rule (no "press space" on touch); the office is in `touch-copy.test.ts`.

## Calendar mode

A toggle (tab on the HUD) swaps the floor for **the week**:
- The office wall becomes a big pixel wall calendar: 7 columns (or a month grid on wide screens), each day a cork board.
- Tasks with due dates are pinned on their day; overdue ones slide to a red "overdue" tray (same idea as `OverdueTray` in `src/components/calendar/`). Calendar events show as appointment cards; workers walk to the meeting room at the event's time in the office view.
- Data comes from what Calendar already uses (`calendar-utils.ts` bucketing); move the pure bucketing into `shared/` if the sim needs it, never copy it.
- Day/night: the office lighting follows the local clock; weekends dim the rooms.
- Same click behaviour: click a pinned card → open it.

## Idle layer (pure cosmetics, no data writes)

- Workers have small routines: coffee machine, water cooler, sitting at their desk when they hold an in-progress card, leaving at the end of the day.
- A ticker on the wall: "3 done today", "next due: Fri" (derived, not stored).
- Unlockable decor from real milestones (first 10 tasks done in a project → a plant). Stored per workspace in local storage like the Angler tank; purely cosmetic and never shown as a reward for "busywork" metrics.
- Optional sound: off by default.

## Performance

- Render with the existing `PixelPainter`/raster path, at the arcade's fixed-tick sim plus a 30 fps cap when idle; drop to ~4 fps when nothing moves and the window is hidden/blurred.
- Entity cap per room (e.g. 30 visible papers; beyond that a "+12" stack). Large workspaces show the floor plan at room granularity only.
- The bridge diff is O(changed rows), not the whole store.

## Phases

1. **The office and opened desks (built).** `build.ts`, `layout.ts`, `models.ts`, `sim.ts` and `render.ts` in `shared/arcade/workspace/`, and the desktop host in `src/components/arcade/office.ts`. The office follows the store live (rebuilt 250 ms after a burst of changes) and people walk to their new desks. Opened at "The Workspace" in the Arcade toolbar. It doesn't animate individual changes yet.
2. **Live events (built).** `events.ts` diffs the office snapshots (`diffOffice`, `groupChanges`); the sim plays labels, flying sheets, a done-board pop and flashes; the desktop host forwards `note:aiWrite*` for a "writing" bubble. Bursts are coalesced and a flurry is sampled. Attribution (who made the change) waits for phase 3. It diffs the store rather than the change feed's rows, which is simpler and catches every writer; the feed's `externalTouched` can later tell you from others.
3. **Agent presence (built).** `session:event` intent → the robot walks to the desk (`agentIntent`); attribution heuristic (`AGENT_WINDOW`, agent-blue labels); click the robot → open the chat (`openAgent` → agent view).
4. **Calendar mode (built: the wall).** The WEEK tab (C) swaps the floor for seven day boards with due tasks pinned on their day and a red overdue tray; clicking a pin opens it. Weekends dim, today is gold. Not built: calendar events as appointment cards, the meeting room, workers walking to meetings.
5. **Mobile.** `PixelGameView` host, a sync/poll bridge, card sheet / note routes; pinnable as a Workspace tool like the other games.
6. **Idle polish.** More routines, decor from milestones, ambient sound.
7. **Pixel chat (the easter egg's easter egg).** While the office is open, restyle the chat panel to match: pixel font for messages, chunky bordered bubbles, and the agent's avatar as the office robot. This should be a theme layer only (a `data-pixel` attribute on the chat root that swaps CSS variables and fonts), never a second chat component, so behaviour can't drift. Respect the font-scale setting and keep code blocks readable: monospace stays monospace.

## Files

- `shared/arcade/workspace/data.ts`: `OfficeData`, zones, the demo office
- `shared/arcade/workspace/build.ts`: store → `OfficeData` (pure)
- `shared/arcade/workspace/layout.ts`: the floor, staffing, walk routes, an opened desk's board and notes
- `shared/arcade/workspace/models.ts`: voxel desks (piles by count), chair, people, props
- `shared/arcade/workspace/sim.ts`, `render.ts`, `DESIGN.md`
- `src/components/arcade/office.ts`: desktop factory (store subscription, open → preview pane)
- Later: `shared/arcade/workspace/events.ts` (phase 2), `mobile/src/components/WorkspaceGame.tsx` + `mobile/app/workspace.tsx` (phase 5)

## Open questions

- **Settled in phase 1:** clicks open the side preview pane (its header can still go to the Board or Notes view), and the office shows the whole workspace as one room.
- **Source marker on rows.** For mobile (and better attribution on desktop), should the change feed record the writer (`renderer` / `mcp` / `agent` / `sync`)? It's a small migration on `change_feed`, and it would make "the agent did this" exact rather than a timing guess.
- **People without accounts.** `assignee` is free text. Map it to People records where the name matches; otherwise make a generic worker.
- **Where it lives.** Under Arcade, or as its own sidebar view ("Office")? Starting under Arcade keeps the surface small; promote it if people leave it open.
