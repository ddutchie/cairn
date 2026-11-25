# The Workspace

An idle office that mirrors the open workspace. It isn't a game with a score: you leave it open and watch your work happen in it. Plan and later phases: `docs/plans/the-workspace.md`.

## The room

- **One room is the workspace.** The back wall has windows (as many as fit either side of the clock and the done board, narrower on a phone), a "done this week" board and a clock hung above the paper bin, with the printer to the right. Planters stand in front of the windows, and one in a sunbeam throws its shadow into it. The coffee machine and the water cooler stand in the bottom-right corner, on the front strip; the robot's pad is bottom left.
- **Each project is a desk.** Busiest projects come first. A desk's paper pile grows with its open tasks: one voxel layer each up to four, then one per two, capped at ten. Its book pile grows with its notes the same way, capped at eight. A red tab on the pile means a card is overdue. The desk's front edge is in the project's colour, and its name tag floats below it.
- **People sit where they're busiest.** Each assignee sits at the project where they hold the most cards in progress. The busiest people choose first, and a second person on the same project stands beside the desk. Unassigned work in progress brings the contractor, in hi-vis. A lit monitor means somebody is working there.
- **Idle life.** Seated people get up every 10–35 seconds to go to the coffee machine, the water cooler or a colleague's desk. They walk the aisles and lanes (`route`), never through a desk, and come back.
- **Daylight follows the clock.** Sun falls through the windows by day. From 17:00 the room dims, and after dark each monitor left on is the light: a dithered pool of screen-blue light on its desk, its piles and whoever sits there, while the rest of the room stays dark. The darkness is one cached image (`nightMap`), rebuilt only when the room, the lit desks, the open windows or the hour change; daylight through the open windows cuts warm beams through it at dusk or with the lights off. The floor planks and sunlight are cached the same way. `calm` (Reduce Motion) keeps people at their desks.
- **Sizes.** A workspace small enough to fit gets desks at 3× (`zoom`); otherwise they're drawn at 2×, and pages hold the rest (arrows in the header, or ← →). A desk needs `deskHeight(k)` of floor (its tallest pile down to its name tag), and desks stay between the back wall's props (`BACK_GAP`) and the front strip kept for planters and the robot's pad (`FRONT_STRIP`). A test checks that no desks overlap across project counts and screen sizes. Seated people move with their desk when the floor is laid out again.

## An opened desk

Click a desk to look down at its project:

- **Board**: a cork tray per board column, with cards pinned in board order. Each card shows its priority colour, the assignee's initials in that person's shirt colour, and a pin that is red when overdue and amber when due today. A done column shows the week's count instead of cards. A column that runs out of room shows "+N more", and columns that don't fit a narrow screen are counted in the corner.
- **Notes**: a ruled page of note spines, pinned notes in gold, paged when there are many.
- Clicking a card or note emits `{ k: "open", ref }`. The desktop host opens it in the side preview pane, so the office stays in view. Esc (or "< OFFICE") goes back; ← → step through the desks; B and N switch tabs.

## Live data

The sim never writes. `setData` takes a fresh `OfficeData` (built by `build.ts` from the store), re-lays out the room, and keeps everyone where they are. Someone whose work moved to another desk walks over to it. An open desk stays open unless its project disappears. Both hosts also rebuild when the date changes, so overdue and "done this week" don't go stale overnight. The desktop host rebuilds 250 ms after a burst of store changes, so a chat agent editing ten cards moves the office once.

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
- **Milestone planters.** A project with 10 finished cards earns a planter — tall snake-plants and bushy pothos alternate along the back wall, window spots first — kept once unlocked. Up to six show beside the corner one; the host persists the unlocked set per workspace (desktop local storage, phone device storage) and the sim flags new ones with `decorDirty`.
- **Things to tap.** The coffee machine sends the nearest free worker for a cup (steam, and a "CUPS TODAY" count that resets with the date); with nobody free it just brews. The water cooler gathers two people: the first repeats a recent change as gossip ("HEARD? LAUNCH: 2 DONE!", kept in `news`), the second answers. A planter sways and someone walks over with a watering can; the hover names whose milestone it is. The done board lists this week's done count per project, and a row opens that desk. The light switch (top left of the back wall) is automatic by default; a tap switches the lights on or off by hand until the next dusk or dawn. Off by day, the room dims and only the windows and monitors light it. A window toggles its blinds, which also takes its sunbeam off the floor and out of the dark overlay. The printer prints a test page.
- **Errands.** Seated workers also water planters now and then; every errand carries an `Errand` (coffee, chat, water, print, deliver, visit) that decides what they do on arrival and what they carry (a can, a sheet, a cup on the way back), and remembers its walkway (`via`) for the walk home.
- **The printer.** A new note prints (`printQueue`, three at most), then the nearest free worker collects it and carries it to that project's desk.
- **Celebrations.** A refresh that empties an open column through finished or moved work (not deletions), or that earns a planter, plays a party: "HIGH FIVE!" or "MILESTONE!", confetti over the desk, and everyone not walking hops. `calm` keeps the label and drops the hops.
- **After dark.** Whoever holds a desk with overdue work stays late at it (no errands, a steaming mug), and only they can be clicked. The night cleaner comes in at the door (bottom left), sweeps up missed paper balls (the robot stays on its pad at night) and patches of floor, says hello when tapped, and leaves at dawn.
- **People look different.** Each person gets a shirt, hair colour and style (short, long, bald, or a cap) from their name, and `castLooks` re-draws anyone who would match someone already in the office, so no two look alike; sticky initials use the same shirt. Caps are bright and never the shirt's colour (a blue cap on a blue shirt read as a uniform).
- **The cat.** It wanders the floor around the desks by day, sits or naps, sometimes hops up and strolls along the front edge of a desk, and after dark curls up on a lit monitor. Tapping it pets it (hearts, and it wakes). It is kept shallow because a stack turns depth into screen height.
- **Seasons.** The windows show snow from December to February (with snow on the sills) and falling leaves from September to November, by the northern-hemisphere calendar.
- Ambient sound is not built: the pixel hosts have no audio path, so the office stays silent.

## Calendar mode

The WEEK tab (C) swaps the floor for the week wall: seven day cork boards from the shared `week.ts` bucketing, with dated open cards pinned on their day (priority stripe, project accent chip) and a red OVERDUE tray along the bottom for everything past due. Today is gold, weekends dim. The ‹ › arrows and arrow keys page the wall week to week (the header names the range); reopening returns to this week. Clicking a pin opens that task in the side panel, exactly like a desk card; Esc or OFFICE goes back. Meeting-room events and workers walking to meetings are not built yet.

## Pixel chat

While the office is on screen the desktop chat panel dresses to match: a pixel face (Pixelify Sans) for messages and the composer, square two-pixel borders with a hard shadow, and the office robot as the agent's avatar. It is a theme layer only: `ArcadeView` sets `officeOpen`, `UnifiedChatPanel` puts `data-pixel="office"` on its root, and CSS in `globals.css` does the rest, so there is one chat component. The user's chat theme keeps its colours, sizes follow the type scale and font-size setting, and code stays monospace. Leaving the office (including by clicking the robot, which opens the agent view) drops the theme.

## Tuning notes

- Sprite stacks turn a model's depth into screen height, so keep heads shallow and chair backs low or a seated person reads as a post. A front face only a voxel or two big gets lost: the waiting robot turns to the room and its eyes are drawn flat on its head.
- The demo office has no due dates of its own; the week wall dates it around today (`withDemoDates`), with its overdue cards due yesterday so the wall agrees with the done board.

- The office is drawn with voxel stacks (`models.ts`) like Task Force and Wayfinder: `makeModel` shades each layer and the renderer drops a shadow under each stack. Desk models are cached by their pile heights, lit state, overdue state and accent, so a model is rebuilt only when its counts change. Draw time in the harness is about 0.5 ms at 480×320.
- A seated person's click area covers only their visible top half, so a click on the desk itself opens the project rather than the person.
