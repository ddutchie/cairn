# Breakout — Game Design & World Vision

## What It Is
**Brick Breaker (Breakout)** is a fast stacked-voxel paddle-and-ball arcade game where each brick represents a project, note, or task card from your workspace.

## What We're Trying to Achieve
- **Tactile Retro Polish:** Crisp paddle deflection angles, multi-hit voxel bricks, combo scoring, and clean full-width HUD framing.

## The Loop
- **Serve:** the ball rests on the paddle. A tap, click or Space launches it, angled the way the paddle is moving.
- **Rally:** drag (touch), move the mouse, or hold the arrow keys or A/D to steer the paddle. Where the ball meets the paddle sets its angle (edges send it wide), and some of the paddle's motion carries into it.
- **Bricks:** each brick breaks in one hit for +1. Consecutive bricks without touching the paddle build a streak; from 3 the streak shows (`x3`) with more shake and hit-stop. Touching the paddle resets it.
- **End:** clearing every brick wins the board; the ball falling past the paddle ends the run. Either way a tap after a short pause starts a new board on the next biome.

## Workspace Data
The grid is `ROWS` (7) rows by 6–16 columns (by width), filled in order from the workspace's projects, notes, task cards and tags. A brick's kind sets its look and the colour of its pop; the label shows on it. Kinds don't change durability or points.

## Tuning
| Value | Setting |
|---|---|
| Ball speed | `BASE_SPEED` 2.1 px/frame, stepped in two halves per frame |
| Paddle | `PAD_W` 32 px, eases 45% of the way to its target each frame |
| Keyboard paddle speed | max(3.6, playfield width / 60) px/frame |
| Brick | `BW` × `BH` = 26 × 10 px on a 28 × 12 grid |

No playthrough timing notes yet; record them here when tuning ball speed or paddle size.
