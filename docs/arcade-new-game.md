# Making a new Arcade game

The Cairn Arcade is a set of small pixel games built from the user's own projects, tasks and notes. Each game is written once in `shared/arcade/<game>/` and runs on desktop (HTML canvas) and mobile (Skia) through thin wrappers. This guide walks through adding one, from an empty folder to a cartridge in the menu.

Play-test it in a browser as you go: [`docs/arcade-play.md`](arcade-play.md).

## 1. The shape of a game

```
shared/arcade/<game>/
  sim.ts      the game: state, rules, input, events. No drawing, no platform code.
  render.ts   the picture: a PixelPainter subclass that draws the sim's state.
  models.ts   voxel models (optional): characters and props as stacked slices.
  DESIGN.md   what the game is, its loop, and the tuning notes behind its numbers.
```

Keep the split strict. The sim never draws, and the renderer never changes game state (it may keep its own caches and animation timers). Tests drive the sim alone, and the harness and both apps drive the same pair.

Everything under `shared/` must be pure TypeScript: no Electron, Node, DOM or React Native APIs.

## 2. The sim

Copy the constructor and input surface from an existing sim (`powder-run/sim.ts` is a compact one). Every sim takes the same spec and exposes the same members, because the harness, `PixelGameView` (mobile) and `ArcadeView` (desktop) all rely on them:

| Member | Purpose |
|--------|---------|
| `constructor({ width, height, hud, inputMode, best, projects })` | `projects` is `ArcadeProject[]` from `pixel/arcade-data.ts`: the user's projects, tasks (with priority and due scope) and notes. `best` is the stored high score. |
| `state` | A string union (`"title" \| "play" \| …`). The title screen is a state, not a separate component. |
| `step()` | One fixed 60 Hz tick. All time is counted in frames, never wall-clock. |
| `events: E[]` | Things that just happened (`"hit"`, `"clear"`…). The app reads and empties it each frame to play haptics. |
| `down(x, y)`, `move(x, y)`, `up()` | Pointer or touch, in game pixels. |
| `setKey(code, down)` | Keyboard (desktop): return `true` if the key was used. |
| `resize(width, height)` | The iPhone Duo folds and unfolds mid-game; recompute layout, keep state. |
| `best`, `calm` | High score; `calm` turns off screen shake and flashes (Reduce Motion). |

Rules of thumb:

- **Seed everything.** Use `mulberry32`, `hash2` and `fbm` from `pixel/terrain.ts`, seeded from the projects, so the same workspace gives the same world. Tests depend on it.
- **Use the user's data for meaning, not decoration.** Overdue tasks are threats, priorities are value, notes are discoveries, projects are places. A player should learn something about their week.
- **Lay out against `hudFrame(hud, W, H)`** (`pixel/hud.ts`). It returns the `top`, `bottom` and `content` rows clear of the iPhone Duo's rails, sensor housing and safe areas. Never hard-code a margin.
- **`inputMode`** is `"touch"` on mobile and `"pointer"` on desktop: touch needs on-screen buttons and swipes where desktop has keys.

## 3. The renderer

Subclass `PixelPainter` (`pixel/painter.ts`). It gives you `rect`, `circle`, `line`, `text`/`textC` (the 3×5 font in `pixel/font.ts`; add a glyph there if you need a character, or it renders as `?`), `image`/`imageRect`, and `stack` for voxel models drawn as stacked slices. `draw()` paints a frame and returns `this.snapshot()`.

Two ways to draw a world:

- **2D and stacked voxels** (Task Force, Stacker, Wayfinder's sea). Cheap when the scene is a few hundred calls. Every painter call is a native call on mobile, so a frame of a thousand `rect`s is slow on a phone even when Chrome draws it in 2 ms. Bake anything static into an image once (`makeImage(w, h, rgba)`) and draw that.
- **Real 3D** (Tideglass, Powder Run, Wayfinder's islands). Render into a `Framebuffer3D` (`pixel/raster3d.ts`), sized with `fbSizeFor(W, H)`, then hand it over in one `imageRect`. Use `makeCam3D` for the camera (+Z up), `drawTri` for ground, `drawMesh` for models, and `fogR/G/B` with `fogStart`/`fogEnd` for distance haze. Then draw the 2D HUD on top. `project()`-style helpers (see `wayfinder/island3d.ts`) hang 2D labels on 3D points.

For 3D models:

- **Characters and hero props:** voxel `Model`s through `meshFromModel` (greedy-meshed, with an automatic LOD).
- **Scenery in bulk:** `LowPoly` (`pixel/lowpoly.ts`), which builds trees, rocks and crags from a few dozen flat-shaded triangles with the same lighting as the voxel meshes. A voxel tree costs about 700 triangles; a low-poly palm about 60.

Budget: keep a 3D frame near **10k triangles**, and keep `npm run arcade:bench` for the game under about 16 ms (the Wayfinder island is about 15 ms at the Duo's size). Check it in the harness with `calls()` and by counting `drawTri` calls (see `docs/arcade-play.md`), and choose each prop's detail by its size on screen.

Colours: arcade pixel code uses hex strings (the CSS-variable rule is for the app's UI, not the game canvas).

## 4. Wire it into both apps

1. **Menu:** add the id to `ArcadeGameId` and a cartridge to `CARTRIDGES` in `shared/arcade/menu.ts`, and a little animated card scene in `shared/arcade/menu-render.ts`. The menu paginates by itself (`PER_PAGE`).
2. **Desktop:** add a `GameFactory` to `GAMES` in `src/components/arcade/ArcadeView.tsx` (copy `createPowderRun`).
3. **Mobile:**
   - `mobile/src/components/<Name>Game.tsx`: a `create<Name>` factory returning a `PixelGame`, an `onEvent` that maps events to `haptics`, and a view wrapping `PixelGameView` with a `bestKey`.
   - `mobile/app/<id>.tsx`: the route, wrapping the view in `PixelGameRoute`. The file name must be the game id: the menu opens `/<id>`.
   - Add the id to `PIXEL_GAME_ROUTES` in `mobile/app/_layout.tsx`.
4. **Harness:** add the pair to `GAMES` in `scripts/arcade-play/play.ts` and `scripts/arcade-play/bench.ts`.

## 5. Tests

Add `mobile/src/games/<game>/<game>.test.ts` (Vitest, runs in plain Node). Cover:

- The loop: start, win and lose states, and a retry, by stepping the sim and feeding input.
- The rules that use the user's data (an overdue task is a threat, priority sets value…).
- A render smoke test with a no-op backend (copy `noopBackend` from `basecamp.test.ts`), including a `resize` to a Duo-unfolded width.
- Update `mobile/src/games/arcade/arcade.test.ts` for the new cartridge order.

```bash
cd mobile && npx vitest run src/games
```

```bash
npm run type-check:all
```

## 6. Before you ship

- **Play it in the harness** at folded and unfolded Duo sizes (`w=233&h=320`, `w=320&h=320`, with `duo=1` and `touch=1`).
- **Measure.** Chrome numbers flatter both kinds of game; Skia's per-call cost and Hermes's interpreter don't show there. `npm run arcade:bench -- <game>` times a frame under an interpreter and counts painter calls (see `docs/arcade-play.md`); then confirm on a device.
- **Write `DESIGN.md`:** the loop, what each piece of user data does, and the tuning notes (with the numbers a bot or a playthrough produced).
- **Changelogs:** add a line to `changelogs/` and `mobile/changelogs/` (see AGENTS.md for which file), and a What's New entry if it's a headline feature.
