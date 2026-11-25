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

## Tuning notes

- The office is drawn with voxel stacks (`models.ts`) like Task Force and Wayfinder: `makeModel` shades each layer and the renderer drops a shadow under each stack. Desk models are cached by their pile heights, lit state, overdue state and accent, so a model is rebuilt only when its counts change. Draw time in the harness is about 0.5 ms at 480×320.
- A seated person's click area covers only their visible top half, so a click on the desk itself opens the project rather than the person.
