# Arcade play harness

`scripts/arcade-play/` runs one shared arcade game (`shared/arcade/<game>/sim.ts` + `render.ts`) in a plain browser canvas, with no Electron app or Expo build around it. Use it to play-test, tune, screenshot and profile a game while you edit it.

```bash
npm run arcade:play
```

It serves `http://localhost:4179` (pass another port as `npm run arcade:play -- 4200` or `PORT=4200`). esbuild rebuilds `play.ts` and everything it imports on each page load, so **refresh the page after an edit**. In the Claude desktop app the `arcade-play` entry in `.claude/launch.json` starts the same server in the browser pane.

## URL parameters

| Param | Default | Meaning |
|-------|---------|---------|
| `g` | `tideglass` | Game: `wayfinder`, `tideglass`, `powder-run`, `basecamp` |
| `w`, `h` | `233`, `320` | Logical canvas size in game pixels (the Duo folded is about 233×320, unfolded about 320×320) |
| `k` | `2` | Display zoom (CSS pixels per game pixel) |
| `duo` | off | `duo=1` applies a rough iPhone Duo HUD cut-out, so HUD placement inside `hudFrame()` can be checked |
| `touch` | off | `touch=1` starts the sim in `inputMode: "touch"` (on-screen buttons, swipe controls) instead of pointer + keyboard |

Examples:

- `http://localhost:4179/?g=wayfinder&w=320&h=320&k=2`
- `http://localhost:4179/?g=powder-run&w=233&h=320&k=3&touch=1`
- `http://localhost:4179/?g=basecamp&w=320&h=320&duo=1`

Mouse and keyboard go to the sim exactly as on desktop (`down` / `move` / `up`, `setKey`). The line above the canvas shows the average draw time over the last 30 frames and the sim's `state`.

## Console helpers

| Global | What it does |
|--------|--------------|
| `sim`, `ren` | The live sim and renderer. Poke state directly, e.g. `sim.state = "sail"; sim.land(sim.islands[0])` |
| `paused` | `paused = true` stops stepping the sim (drawing continues), so a scene holds still |
| `measure(n = 60)` | Average `ren.draw()` time in ms over `n` frames, advancing only `sim.t` |
| `calls()` | Surface calls one frame makes (`drawRect`, `drawStack`, `drawImageRect`…) |

`measure()` is the CPU cost of drawing in Chrome. **`calls()` is the better predictor of mobile cost:** on the Skia backend every surface call crosses into native code, so a frame of a thousand `drawRect`s is slow on a phone even when Chrome draws it in 2 ms. The 3D games render into a `Framebuffer3D` and hand it over in one `drawImageRect`, which is why they make tens of calls per frame, not thousands. Confirm on a device before trusting either number.

## Adding a game

Import its sim and renderer in `scripts/arcade-play/play.ts` and add it to `GAMES`. A game works in the harness if its sim takes the standard `{ width, height, hud, inputMode, projects }` spec and its renderer takes `(backend, sim)` — the same contract `PixelGameView` (mobile) and `ArcadeView` (desktop) rely on. The harness feeds it `DEMO_ARCADE_PROJECTS`.
