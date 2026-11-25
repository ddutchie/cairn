# Angler

A pixel aquarium you stock by fishing your workspace.

## The loop

1. **The tank** is home, seen side-on: sand, swaying weed, bubbles from a stone cairn, and the fish you kept. Tap a fish to see what it is (its task or note, project, weight and points) and to let it go. GO FISH goes to a pond.
2. **The pond** is seen from above, like Wayfinder's sea. Each project is its own pond in its own biome: tropic lagoon, desert oasis, tundra pool, volcanic lake. SPOT > moves to the next pond, and only that project's fish swim there.
3. **Cast.** Tap the water (or Space to cast straight ahead of the rod). The bobber arcs out with its shadow on the water.
4. **Wait.** A fish comes to the bait nose-first, nibbles one to three times (a ripple and a light buzz), then takes it: the bobber plunges and `!` flashes for `BITE_WINDOW` (48 frames). Strike with a tap, a click or Space.
   - A strike pressed up to `STRIKE_BUFFER` (10 frames) before the plunge is held and counts.
   - A strike during the nibbles only makes the fish wary: one more nibble, once per fish, with no spooking. A player who keeps pressing on the dips still lands it, because later early presses add no more nibbles.
   - Missing the window lets it get away.
5. **Fight.** The hooked fish swims any direction and turns every second or two (a `!` warns of the turn). An arrow shows its heading, and a ring around the angler shows where to point. Point the rod its way, by swiping or with the arrow keys (8 directions on a keyboard).
   - Within about 75° (`MATCH`, cosine 0.25) drains its stamina and eases the line.
   - Anything wider strains the line, a full LINE bar snaps it, and a fresh fish fought badly takes line.
   - A fish under 20% stamina is tired and surfaces as the real voxel fish.
6. **Reel.** The reel pops up in the corner from the start of the fight. Holding it reels slowly and cranking it in a circle reels faster. Reeling a fresh fish strains the line hard, and reeling a tired one barely does. Leave a tired fish unreeled for `RECOVER_FRAMES` (2.5 s) and it gets its second wind.
7. **Catch.** It leaps from the water onto a card, spinning as a voxel model over a pool of light, with its species, weight, task or note, title, project and points. KEEP drops it into the tank with a splash, and LET GO sends it back to the pool.

## Looks

- **Pond:** one baked image per pond and size, made from the shared biome palettes. Water darkens with depth from the foam line in, and dithered banks fade to the biome's ground, with lit trees and rocks thickening away from the water. Lily pads, ice floes or rocks float near the banks, and the plank dock casts a shadow. Per frame there are glints, ripples, fish as voxel shadows (darker nearer the surface), and the angler and tackle box as voxel stacks.
- **Fish models** (`models.ts`) are built from the same seeded design as the tank sprites, seen from above: belly, body and patterned back layers, a fanned tail, pectoral fins and a dorsal ridge. Fins and markings take the project accent.
- **Tank depth:** each fish has a depth `z`. Fish further back use a 72% sprite under a water tint, swim slower, and draw first. Each throws a shadow on the sand that fades with height. The floor slopes away into a darker band, light ripples over the sand, and two thick weed blades and big bubbles pass in front of the glass. A fish turning round narrows to nothing and comes back facing the other way.

## The user's data

- **Tasks are fish, by priority.** Low gives a minnow, medium a perch, high a bass, urgent a pike. Bigger fish pull harder and take longer to tire.
- **Notes are the exotic ones, by length.** Under 400 words gives an angelfish, under 1200 a puffer, longer a koi.
- **Overdue tasks fight harder.** Pull ×1.25, faster turns, 1.5× points, and a darker body with a red eye.
- **Projects are places.** Each project is a pond in its biome, and its accent colours its fish.
- **The tank empties as work gets done.** The tank saves fish by task or note id. On the next visit, any whose task is no longer open, or whose note is gone, swims up and out, and a banner says how many. The demo workspace keeps whatever it has, so a thin workspace never wipes a real tank.
- **One tank per device, shared by every workspace.** A fish only swims home when its project is open here and its task or note is gone. A fish from a project that isn't in the open workspace (another workspace, or a project that was deleted) stays, because this workspace can't tell whether its task is done. The games cap what they show per project (12 tasks, 8 notes), so the host also passes `liveIds`, every open task and live note in the loaded projects with no cap: a fish whose task is still open but didn't make the cut stays too. Switching workspaces therefore never empties the tank, and no saved data needed migrating: the key and format are unchanged, and older fish saved without a project id are kept the same way.
- **Letting a fish go** puts the task back in the pond as it is now (a task raised to urgent comes back as a pike). A fish from another workspace just swims off.
- Size and weight are seeded from the id, so the same task is always the same fish.

## Persistence

The host calls `sim.persist(write)` each frame, which saves `sim.snapshot()` (the fish in the tank) whenever `tankDirty` is set: on keep, on let-go, and when done fish leave on open. A failed write leaves the change pending and is retried about every two seconds. Saved fish are checked one by one when the tank loads (an own species, a whole-pixel size in range, real numbers and a hex accent); a bad entry is skipped and the rest are kept. Mobile writes the JSON to device meta (`angler_tank`) and desktop to local storage (`arcadeAngler:tank`). Where the fish were swimming is not kept, only what is in the tank. Best is the tank's highest total points.

## Tuning notes

- `TANK_MAX` is 16, which keeps a full tank readable at the folded Duo width.
- Stamina is in frames of a perfect point: a minnow takes about 3 s and a pike about 7 s, with turns on top. A careful bot (it swipes along the heading and reels once the fish is tired) lands fish reliably.
- Pointing dead against the fish snaps the line in about a second.
- Frame cost: about 220 painter calls in the stocked tank and about 60 in a pond fight, under 0.1 ms of JS in the harness. The tank and each pond are baked into one image the first time they are shown.
