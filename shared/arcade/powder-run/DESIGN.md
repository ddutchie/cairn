# Powder Run — Game Design & World Vision

## What It Is
**Powder Run** is a 3D halfpipe snowboarding arcade game built on `shared/arcade/pixel/raster3d.ts`. Each Cairn project becomes a run down a mountain (`RUN 1 OF N`). You carve the pipe for speed, launch off the lips, throw tricks you choose, and collect the project's **Tasks** and **Notes** on the way down.

## The Loop
- **Speed is earned.** Speed drifts back toward cruise (3.6). Riding *down* a wall (pumping) turns height into speed, and every clean landing adds more. A bail or a boulder halves it. The camera pulls back and widens as you go faster, and speed lines appear.
- **The lips are the launch pads.** Carving fast up a wall sends the rider straight up and back down onto the same wall, which is the next pump. A tap on the snow is a small ollie: enough for a grab, not a spin.
- **Tricks are chosen and take time.** In the air, arrows (or a swipe on touch) pick the trick: left/right = 360 (30 frames; stacked spins become 720, 1080), up = backflip (36 frames), down/tap = method grab (16 frames, can be let go late). A bar shows progress.
- **Land it to bank it.** Finished tricks are *held*, and their points only count on a clean landing, multiplied by the landing chain (capped at x5). Landing mid-rotation is a **bail**: the held points, the chain, a heart and half your speed are lost.
- **Hearts count.** Three hearts. Boulders (from overdue tasks) and bails each cost one. At zero the run is over and you retry *that* project from the score you started it with. Clearing a run gives a heart back.
- **The valuable line is the risky one.** Task value follows priority (low 60 → urgent 260), and higher priorities sit higher on the walls. Notes float above the lips and can only be reached in the air.
- **Every run is graded.** Par is the run at about 4.1 speed. The grade (S/A/B/C) comes from the share collected, whether you beat par, and bails; S needs 85%, under par, no bails. The bonus is the grade (1500/800/400/100) plus time under par.

## The World
- **Time of day per run** cycles day → dusk → night → dawn, changing the sky, fog, snow tint and mountain ridge. Dusk and night add lamp posts along the rims; night adds stars.
- **A mountain ridge** (seeded per run) fills the horizon and slides with the rider.
- **Split gates** in the project's accent colour every 640 units, and a checkered finish arch.
- Pines line the rims in two depths; snow falls throughout.

## Tuning Notes
- Air time is measured against the slope: `launch()` subtracts the slope's fall (`0.11 * vy`) from the lift, so air time doesn't depend on downhill speed.
- A scripted carver (no tricks) finishes in about 690 frames against a par of 780. Straight down the middle takes about 890.
- One trick per jump survives a run. Greedily stacking tricks wipes out by about 40% of the run.
