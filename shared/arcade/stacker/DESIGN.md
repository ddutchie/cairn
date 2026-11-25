# Stacker — Game Design & World Vision

## What It Is
**Cairn Stacker** is a one-tap timing game where you drop swinging stone slabs labeled with your workspace tasks to build the tallest, cleanest cairn possible.

## What We're Trying to Achieve
- **Pure Arcade Timing:** Instant restart, clean overhang slicing, camera climb as the tower rises into the sky, and satisfying perfect-drop feedback.

## The Loop
- **Start:** a tap, click or Space starts a run on a base slab. A new slab slides back and forth above the tower.
- **Drop:** a tap, click or Space drops it. Whatever hangs past the slab below is sliced off and tumbles away as debris; the kept part is the new top, so the tower narrows with every miss.
- **Perfect:** a drop within `PERFECT` (2 px) of the slab below snaps flush, keeps the full width, and builds a combo (`PERFECT x3`). Any slice resets the combo.
- **Fail:** a slab that misses the tower entirely falls and ends the run. After a short pause a tap restarts from the base. Score is the number of slabs placed; best is kept per device.

## Workspace Data
Slabs are labelled with the workspace's projects, notes, task cards and tags, cycled in order, and the label's kind picks the slab's stone and colouring. The data only names and colours the slabs: it does not change speed, width or scoring.

## Tuning
| Value | Setting |
|---|---|
| Base slab width | `BASE_W` 104 px, capped at 56% of the screen width |
| Slab height | `SH` 11 px |
| Perfect window | `PERFECT` 2 px |
| Slide speed | starts at 1.25 px/frame (× width / 180), +0.045 per drop, capped at 3.1 × width / 180 |
| Camera | keeps the top of the tower at about 47% of the screen height |

### Bot baseline (2026-11-25, `StackerSim` 233×320, NO_HUD, seed 7)
- Policy: drop when `|mover.x - top.x| <= 1.0` px (near-perfect play).
- 32 perfect drops in 10,800 frames (180 s), avg ~72 frames/drop; combo x32; speed 1.25 → 3.06 px/frame (cap 3.1 × 233/180 ≈ 4.01).
- The 1 px window stalls past ~3 px/frame (the mover steps over it), so the run stops gaining after drop 32. A wider-window or predictive bot is needed to probe the speed cap; widening `PERFECT` or lowering the +0.045/drop ramp should show up here as more drops/180 s.
