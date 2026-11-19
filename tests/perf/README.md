# Graph canvas benchmarks

## Quick: layout settle (`npm run bench:graph-settle`, ~20 s)

Times the Force layout settling, which is where large graphs felt slowest:
a cold open of the Knowledge Graph, reopening it, and three "Show
neighbourhood" drill-ins and Esc back out. For each it reports how long until
the layout settled, when the graph first appeared, how many full redraws it
took, and frame timing in between. Takes the same `GRAPH_JSON`, `HEADED`,
`DPR` and `CPU_THROTTLE` options as below, plus `NO_DASH=1` to draw dashed
edges solid. Results go to `test-results/graph-perf/graph-settle-*.json`.

## Architecture graph (`npm run bench:graph-arch`)

Pan, zoom, hover and settle on a synthetic code graph (`FILES`, `EDGES`; default 400/2000) in Agent → Architecture → Graph, at full and 1× resolution.

## Full: interaction (`npm run bench:graph-ui`, ~5 min)

This one boots the renderer against the Next dev server with
mocked IPC, loads a large knowledge graph, and drives the Force and Radial
views. For each scenario it reports:

- frame timing (fps, p50/p95/max, share of frames over 25 ms)
- JS time spent inside rAF callbacks (the draw routines)
- 2D canvas calls per frame (stroke, fill, text, dash)
- for the baseline variants, a Chrome trace grouped by kind (script, commit,
  layout, paint…) and the hottest JS functions from a CPU profile

Each variant reloads the page with one thing changed (hulls off, labels
"all", semantic edges shown, DPR 1, or dashes / text / shadows switched off
in the canvas), so comparing it to the baseline shows what that thing costs.
Results print as tables and are saved to `test-results/graph-perf/*.json`.

## Options

| Env | Effect |
|---|---|
| `GRAPH_JSON=/path/graph.json` | Benchmark a real graph instead of the synthetic one |
| `CPU_THROTTLE=4` | Slow the renderer CPU N× (approximates a slower PC) |
| `HEADED=1` | Visible window; the canvas is rasterised on the GPU |
| `DPR=1` | Device pixel ratio (default 2) |
| `ONLY=force` / `ONLY=radial` | One layout only |
| `VARIANTS="force baseline;radial baseline"` | Named variants only (`;`-separated) |

Headless Chromium rasterises 2D canvas in software, so headless numbers show
the cost when the canvas has no GPU acceleration. `HEADED=1` runs a visible
window, which normally uses the GPU; confirm in `chrome://gpu` that canvas
is hardware accelerated before reading the numbers as GPU numbers.
The dev server runs on its own port (`BENCH_PORT`, default 3217) and is never
reused unless `REUSE_SERVER=1`.

## Benchmarking your own graph

In Cairn, open the Knowledge Graph for the workspace, open the developer
tools and run:

```js
copy(JSON.stringify(window.__cairnStoreRef.getState().graphData))
```

Paste the clipboard into a file and run:

```bash
GRAPH_JSON=~/graph.json npm run bench:graph-ui
```

The file contains note, card and tag titles, so keep it local.
