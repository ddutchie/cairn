# Inbox Zero — Game Design & World Vision

## What It Is
**Inbox Zero** is a lane-based stacked-voxel tower defense game where incoming task cards march along a winding path toward your board and you place/upgrade workflow towers to triage them before they overflow.

## What We're Trying to Achieve
- **Snappy Tactical Loop:** Clear wave escalation, distinct tower roles, crisp projectile/explosion feedback, and workspace-driven card titles.

## The Loop
- **Waves:** each wave is one project (up to `MAX_WAVES`, 5), smallest first. Its open tasks march as cards down a serpentine path to the board at the bottom. Cards spawn every `70 − 6 × wave` frames, and their HP grows 15% per wave.
- **Build:** pick a tag tower in the shop (tap it, or keys 1–4), then place it on a free cell beside the path. On touch you drag to preview the cell and range ring and release to build; dragging back to the shop cancels. On desktop you hover to preview and click to build.
- **Upgrade:** tapping a placed tower upgrades it, up to level 2, for `cost × (level + 1) × 0.8` focus.
- **Economy:** you start with 40 focus and 5 hearts. A triaged card pays focus by priority, and clearing a wave pays 15 more.
- **End:** a card that reaches the board is overdue and costs a heart; at 0 hearts the run is over. Clearing the last wave wins.

## Towers
| Tag | Cost | Role |
|---|---|---|
| `#QUICK` | 10 | fast, short range, light damage |
| `#BUG` | 15 | slows cards it hits |
| `#FOCUS` | 25 | long range, heavy single shots |
| `#BATCH` | 30 | splash damage |

## Workspace Data
Projects become waves (named and coloured by the project), and each open task is a card carrying its title. Priority sets the card: low 4 HP / 3 focus, medium 8 / 5, high 15 / 8, urgent 26 / 12, with urgent cards moving fastest.

## Tuning
Tower range, fire rate and damage live in `TAGS` and card values in `PRIO` (`models.ts`). No playthrough notes yet; record wave timings and which towers carry each wave here when rebalancing.

### Bot baseline (2026-11-25, `InboxZeroSim` 233×320, NO_HUD, pointer, seed 42, demo workspace)
- Policy: place 2× `#QUICK` at core (0,0) and (2,0), then `#FOCUS` at (3,0) once focus ≥ 25; no upgrades.
- Wave timings (frames at 60 fps): wave 0: 415 frames, wave 1: 1,976, wave 2: 1,946, wave 3: 2,301, wave 4: 1,978.
- Result: reaches the final wave and loses there — 26 triaged, 5 leaked, hearts 0 after 8,616 frames (143.6 s), score 1,310.
- Takeaway: the two-quick-plus-focus opening holds the first three waves (≤2 leaks) but cannot cover the last wave's HP. Balance changes should move this baseline's leak count and the wave it dies on.
