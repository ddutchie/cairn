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

No playthrough timing notes yet; record them here when tuning speed or the perfect window.
