# The Workspace

An idle office that mirrors the open workspace. It isn't a game with a score: you leave it open and watch your work happen in it. Plan and later phases: `docs/plans/the-workspace.md`.

## The room

- **One room is the workspace.** The back wall has windows, a clock and a "done this week" board (the week's done cards across every project).
- **Each project is a desk.** Busiest projects come first. A desk's paper pile grows with its open tasks: one voxel layer each up to four, then one per two, capped at ten. Its book pile grows with its notes the same way, capped at eight. A red tab on the pile means a card is overdue. The desk's front edge is in the project's colour, and its name tag floats below it.
- **People sit where they're busiest.** Each assignee sits at the project where they hold the most cards in progress. The busiest people choose first, and a second person on the same project stands beside the desk. Unassigned work in progress brings the contractor, in hi-vis. A lit monitor means somebody is working there.
- **Idle life.** Seated people get up every 10–35 seconds to go to the coffee machine, the water cooler or a colleague's desk. They walk the aisles and lanes (`route`), never through a desk, and come back.
- **Daylight follows the clock.** Sun falls through the windows by day. From 17:00 the room dims, and after dark each lit monitor is the light: a dithered pool of screen-blue light on its desk, its piles and whoever sits there, while the rest of the room stays dark. The darkness is one cached image (`nightMap`), rebuilt only when the room, the lit desks or the hour change. `calm` (Reduce Motion) keeps people at their desks.
- **Sizes.** A workspace small enough to fit gets desks at 3× (`zoom`); otherwise they're drawn at 2×, and pages hold the rest (arrows in the header, or ← →).

## An opened desk

Click a desk to look down at its project:

- **Board**: a cork tray per board column, with cards pinned in board order. Each card shows its priority colour, the assignee's initials in that person's shirt colour, and a pin that is red when overdue and amber when due today. A done column shows the week's count instead of cards. A column that runs out of room shows "+N more", and columns that don't fit a narrow screen are counted in the corner.
- **Notes**: a ruled page of note spines, pinned notes in gold, paged when there are many.
- Clicking a card or note emits `{ k: "open", ref }`. The desktop host opens it in the side preview pane, so the office stays in view. Esc (or "< OFFICE") goes back; ← → step through the desks; B and N switch tabs.

## Live data

The sim never writes. `setData` takes a fresh `OfficeData` (built by `build.ts` from the store), re-lays out the room, and keeps everyone where they are. Someone whose work moved to another desk walks over to it. An open desk stays open unless its project disappears. The desktop host rebuilds 250 ms after a burst of store changes, so a chat agent editing ten cards moves the office once.

## Changes you can see

`setData` diffs the new snapshot against the old one (`events.ts`, pure) and plays a few effects, so you notice work happening without watching a log:

- A new task: a sheet drops onto the desk's pile and a green "+ TASK" label rises. A finished task: a sheet arcs to the done board, which pops and counts up, with a gold "DONE!". A task moved to another column: a blue "> COLUMN" label. An edited task or note: an amber "EDITED" label. Deletions show red.
- On an open desk the same labels stack at the bottom right, and the new or changed card or note flashes green for a few seconds.
- A note the AI is writing gets a "WRITING..." bubble and a pulse on its desk until the write ends (the desktop host forwards `note:aiWriteStarted` and `note:aiWriteEnded`).
- A burst folds into one label per project and kind ("+ 6 TASKS"), at most three sheets fly per burst, 24 effects play at once, and a refresh of more than 24 changes (an import, a reload) animates a sample. No animation at all for the demo office or when the workspace is switched.
- A card that moves to a different project arrives there as "+ TASK". A project that just appeared brings its cards without announcing them.

A change for an id the agent just touched (a `tool/call` with a `cairnRef` in the last ~2 s) is drawn in agent blue and counts as the agent's: a timing guess, not an audit log. The robot walks to the touched desk when the call starts; the change feed lands what it did. Click the robot to open the agent view.

## Idle life

- **Nights are empty.** The room follows the wall clock: after dark everyone goes home and the workers, their hit areas and their errands go with them. The robot keeps working. At dawn they walk back in and sit down again.
- **The done board keeps score.** DONE this week in big green numerals (it pops when a card lands), with an OVERDUE count in red under it. Tapping the wall clock opens a big analogue-or-digital overlay with the date; the toggle switches faces, any other tap or Esc closes it.
- **Paper basketball.** A seated worker crumples a sheet at the bin by the done board on their own cadence, and tapping the bin calls for one on demand: most swish with a splash, about a third clank off and land on the floor, and the idle robot walks over (around desks, never through), steps back and sinks them. Balls arc higher the further they fly and tumble end over end; `calm` (Reduce Motion) stops the cadence but a bin tap still works.
- **Milestone planters.** A project with 10 finished cards earns a planter on the floor — tall snake-plants and bushy pothos alternate down the bottom-right row — kept once unlocked. Up to six show beside the corner one; the host persists the unlocked set per workspace (desktop local storage, phone device storage) and the sim flags new ones with `decorDirty`.
- Ambient sound is not built: the pixel hosts have no audio path, so the office stays silent.

## Calendar mode

The WEEK tab (C) swaps the floor for the week wall: seven day cork boards from the shared `week.ts` bucketing, with dated open cards pinned on their day (priority stripe, project accent chip) and a red OVERDUE tray along the bottom for everything past due. Today is gold, weekends dim. The ‹ › arrows and arrow keys page the wall week to week (the header names the range); reopening returns to this week. Clicking a pin opens that task in the side panel, exactly like a desk card; Esc or OFFICE goes back. Meeting-room events and workers walking to meetings are not built yet.

## Tuning notes

- The office is drawn with voxel stacks (`models.ts`) like Task Force and Wayfinder: `makeModel` shades each layer and the renderer drops a shadow under each stack. Desk models are cached by their pile heights, lit state, overdue state and accent, so a model is rebuilt only when its counts change. Draw time in the harness is about 0.5 ms at 480×320.
- A seated person's click area covers only their visible top half, so a click on the desk itself opens the project rather than the person.
