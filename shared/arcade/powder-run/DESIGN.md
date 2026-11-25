# Powder Run — Game Design & World Vision

## What It Is
**Powder Run** is a 3D halfpipe snowboarding arcade game built on `shared/arcade/pixel/raster3d.ts`. Each Cairn project becomes a run down a mountain (`RUN 1 OF N`). You carve the pipe for speed, launch off the lips, throw tricks you choose, and collect the project's **Tasks** and **Notes** on the way down.

## The Loop
- **Speed is earned.** Speed drifts back toward cruise (3.6). Riding *down* a wall (pumping) turns height into speed, and every clean landing adds more. A bail or a boulder halves it. The camera pulls back and widens as you go faster, and speed lines appear.
- **The lips are the launch pads.** Carving fast up a wall sends the rider straight up and back down onto the same wall, which is the next pump. A tap on the snow is a small ollie: enough for a grab, not a spin.
- **Tricks are chosen and take time.** In the air, arrows (or a swipe on touch) pick the trick: left/right = 360 (30 frames; stacked spins become 720, 1080), up = backflip (36 frames), down/tap = method grab (16 frames, can be let go late). A bar shows progress.
- **Gems are the score; tricks multiply them.** A task is worth 100 (low) to 600 (urgent), a note 500. Gems taken on the snow bank at once, times your chain. Tricks themselves are worth little (25-60 each); what they do is raise the chain, which multiplies every gem after.
- **Height is the risk.** Low and medium tasks sit on the snow. High and urgent ones float above the walls (`TASK_LIFT`) and notes sit above the lips, so you have to jump to take them. A gem taken in the air is only **held** (shown as "N TO BANK") until a clean landing banks it, times the chain.
- **Land it to bank it.** Landing mid-rotation is a **bail**: the held tricks and gems, the chain, a heart and half your speed are lost. Gravity is 0.14, so a lip jump stays up about 27-40 frames: a 360 (30) fits most of them, a backflip (36) is a real bet, and a second trick is usually a bail.
- **Hearts count.** Three hearts. Boulders and bails each cost one. At zero the run is over and you retry *that* project from the score you started it with. Clearing a run gives a heart back.
- **Boulders are earned.** They come from overdue tasks, and from run 3 on a few more are added. Each sits on a pulsing red pad so it reads from a distance; jump it or go round.
- **Every run is graded on the project, not the clock.** S needs 85% collected with no bails, A 70% with at most one, B 45%. The bonus is the grade (3000/1500/700/200). There is no par time any more: speed is for reaching gems.

## The World
- **Time of day per run** cycles day → dusk → night → dawn, changing the sky, fog, snow tint and mountain ridge. Dusk and night add lamp posts along the rims; night adds stars.
- **A mountain ridge** (seeded per run) fills the horizon and slides with the rider.
- **Split gates** in the project's accent colour every 640 units, and a checkered finish arch.
- Pines line the rims in two depths; snow falls throughout.

## Tuning Notes
- Air time is measured against the slope: `launch()` subtracts the slope's fall (`0.11 * vy`) from the lift, so air time doesn't depend on downhill speed.
- A scripted carver that throws one spin per air lands every jump and wins the demo with a grade C on every run (it collects 1-5 gems a run): the score is in the gems, so carving alone doesn't pay. A rider who chases tasks collects 8-11 and bails a couple of times; one who stays in the middle dies to boulders by run 4-5.
