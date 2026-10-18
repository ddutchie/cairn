# Plan: Replace the mobile Knowledge Graph WebView with a Skia renderer

**Status (2026-10-18):** BUILT in one PR (#243), **not yet verified on a device**. Phase 0's
go/no-go spike was folded into the build: the Skia renderer is the default, and the WebView
stays behind `EXPO_PUBLIC_GRAPH_RENDERER=webview` for one release. Delete the WebView path once
the device checks below pass and a release has shipped cleanly.

### What was built (vs. the phases)

- **Phase 1, layout engine:** `mobile/src/graph/layout.ts` (d3-force with the shared strengths,
  seeded positions, pin/release, `setEdges`). Kept in `mobile/` rather than extracted to
  `shared/`; desktop's worker wrapper is untouched. Extracting a shared core is still open.
- **Phase 2, force parity:** hulls (`hulls.ts`), batched edges, node drag, pinch/pan, labels with
  the shared LOD rules, auto-fit once visually settled, search/filters/semantic edges via the
  shared `GraphChrome` + `useGraphControls` + `filterGraph`.
- **Phase 3, radial parity:** `radial.ts` (d3-hierarchy partition, arc paths, hit-testing,
  interpolation) with the eased drill-in/out and hub-to-go-up.
- **Architecture as built:** `GraphEngine` (`engine.ts`) owns layout, camera and one rAF loop
  that records one `SkPicture` per frame (`scene.ts`); `KnowledgeGraphSkia.tsx` mounts the
  canvas, keeps the camera transform in shared values and forwards gestures.
- **Decisions made while building:** threading = JS-thread ticks (2/frame, 24 warm-up ticks);
  gestures use the legacy `Gesture.*` API with `runOnJS` (node drag mutates the sim); reduce
  motion settles synchronously; pause on blur/background; fonts = system Helvetica/sans-serif
  via `matchFont`; deps added: `d3-force`, `d3-hierarchy`, `d3-polygon`, `d3-shape` (JS only).
- **Not done:** phase 4 cleanup (delete WebView + d3 asset generation), phase 5 extras,
  VoiceOver list fallback, viewport label culling, UI-thread pan/pinch, a node-count cap.


## Why

The Graph tab (`app/(tabs)/graph/index.tsx`) renders in `KnowledgeGraphWebView.tsx`
(704 lines): a `react-native-webview` loading `graph-webview-html.ts` (442 lines) with
D3 inlined from `src/webview-assets/d3-assets.ts` (~274 KB string). That has real costs:

- **iOS reclaims the WKWebView content process** under memory pressure, leaving the
  graph blank. The code works around it by remounting on terminate/foreground
  (`webKey`, `terminatedRef`), which is unreliable by its own comments.
- **Startup and memory:** a ~274 KB JS string plus a second JS engine and DOM for one tab.
- **Foreign interaction model:** pan/zoom/drag come from D3 in a web view, so no native
  haptics, no shared gesture system, and a `postMessage` bridge for every tap.
- **Theming and layout seams:** colours are pushed into HTML; fold/wide/safe-area
  behaviour is approximated around a web view.
- **Skia is already shipped** (`@shopify/react-native-skia` 2.14, Reanimated 4,
  gesture-handler 3), and the project already has the pieces a native graph needs.

Upside beyond fixing the above: 60–120 fps pan/zoom, native haptics on grab/select,
tap targets and accessibility we control, and a renderer we can reuse elsewhere (a
static graph snapshot in a widget, nodes that animate in when a note is created).

## What exists today (the parity checklist)

Behaviour the Skia version must match (from `KnowledgeGraphWebView.tsx` and
`graph-webview-html.ts`):

- **Force layout** with cluster hulls (convex hull smoothed with a Catmull-Rom closed
  curve), zoom 0.2–6×, an initial zoom, auto zoom-to-fit once the layout visually
  settles, node drag (pins the node while dragging), tap to select.
- **Radial layout:** a sunburst that drills in (workspace → projects → notes/cards, plus
  a Tags branch), eased zoom-in/out animation, centre click to go back up.
- **Chrome driven by the parent:** layout mode (Force/Radial, native toolbar menu),
  label mode (`smart`/`all`/`minimal`), hulls toggle, semantic-links toggle (+ loading
  state), search box, node-type filter chips (project/note/card/tag).
- **Data/filters:** node-type filter, then search by title/tag name (keeping parent
  projects of matches so the hierarchy has a bucket), then drop dangling edges.
- **Shared tokens and forces already in `@cairn/shared/ui/graph`:** `nodeTypeToken`,
  `nodeRadius`, `edgeStyle`, `chargeStrength`, `linkDistance`, `collideRadius`,
  `anchorStrength`, `CLUSTER_RADIUS`, `LINK_STRENGTH`, `COLLIDE_ITERATIONS`,
  `ALPHA_DECAY`, `VELOCITY_DECAY`, `shouldShowLabel`, `labelScreenPx`, `labelMaxLen`,
  `buildHierarchy`, `sunburstTypeToken`. These are pure and reusable as-is.
- Desktop already has a worker-based force engine, `src/components/graph/force-layout.ts`
  (+ `force-layout.test.ts`, `force-layout.worker.ts`): d3-force run off the render path,
  positions out as a flat `Float32Array`. It is the model for the mobile engine.
- Host integration to keep: tap → `router.push` to note/card/project with a "Graph" back
  label; side-preview pane on wide layouts (`useSidePreview`); data from
  `getKnowledgeGraph()` merged with semantic edges.

## Target architecture

```
KnowledgeGraph (db) ──► filter/search (pure) ──► layout engine ──► positions (Float32Array)
                                                                      │
                  gestures (pan/pinch/drag/tap) ─► camera (shared values) ─► Skia Canvas
```

- **Layout engine (pure TS, tested):** extract the d3-force setup into a framework-free
  module both platforms use, preferably in `shared/ui/` next to the graph tokens, with
  desktop's `force-layout.ts` becoming a thin worker wrapper over it. Mobile runs it in
  budgeted batches (N ticks per frame on the JS thread) or settles off-screen first and
  animates; positions land in a flat `Float32Array`. Keep seeded positions between
  rebuilds so adding a node doesn't re-scatter the graph. Decide the threading model in
  the spike (see Open questions).
- **Renderer:** one Skia `Canvas`. Edges as a batched path/`Points` per edge style,
  nodes as circles (or an `Atlas` of pre-rendered sprites if profiling needs it), hulls
  as smoothed paths, labels via Skia text with level-of-detail culling using the shared
  `shouldShowLabel`/`labelScreenPx`/`labelMaxLen`. Colours from `useTheme()` via the same
  token map `tokenColor()` in the WebView file, so light/dark and accent changes repaint
  without any HTML round-trip.
- **Camera:** a 2D transform in Reanimated shared values (`.get()`/`.set()`), driven by
  gesture-handler (pan, pinch, double-tap fit) and animated for zoom-to-fit. Picture
  recording/caching so only the transform changes during gestures.
- **Hit testing:** screen → world transform + a quadtree (or brute force while the node
  count is small) for tap and drag-node. Enforce a minimum touch radius (~22 pt) even
  for small nodes.
- **Radial sunburst:** `d3-hierarchy` partition + arc paths drawn as Skia paths;
  drill-in/out by animating a shared progress value (mirrors `zoomTo` in the WebView).
- **Interactions with feel:** haptic on grabbing a node and on selection; `reduceMotion`
  skips settle animation; pause the simulation when the screen loses focus or the app
  backgrounds.
- **Accessibility (new):** the WebView offers none. Provide a VoiceOver-friendly list
  fallback of the visible nodes (and expose the selected node's label).

## Phases

0. **Spike, behind a dev flag** (`GRAPH_RENDERER=skia|webview`): render precomputed
   force positions in Skia with pan/zoom/tap, no layout engine yet. Measure on a device
   with the largest real workspace and a synthetic 2k-node / 5k-edge graph. Go/no-go on
   frame rate and memory. Also confirm Skia text/fonts look right at small sizes.
1. **Layout engine:** extract the shared pure d3-force core, port desktop's worker
   wrapper to it, add mobile batching, port/extend `force-layout.test.ts`.
2. **Force parity:** drag, hulls, label modes + LOD, search highlight, filters, semantic
   edges, initial zoom and auto zoom-to-fit, theme repaint, wide/fold layouts.
3. **Radial parity:** sunburst with animated drill-in/out and centre-to-go-up.
4. **Cutover:** default to Skia, keep the WebView path behind the flag for one release,
   then delete `KnowledgeGraphWebView.tsx`, `graph-webview-html.ts`,
   `webview-assets/d3-assets.ts` and the d3 portion of `scripts/gen-webview-assets.js`
   (KaTeX and Mermaid assets stay: they serve notes, not the graph).
5. **Extras (optional):** animated node arrival when a note/task is created, a static
   graph snapshot for a widget (the layout is deterministic given positions), tying into
   the cairn-stack redesign (`mobile-capture-and-widgets.md`).

## Dependencies

`d3-force`, `d3-hierarchy`, `d3-polygon`, `d3-shape` (and `d3-quadtree` if used) are small,
pure JS, and no native code, so this stays an OTA-able JS change. `d3 ^7.9.0` is already in
`mobile/package.json` (it generates the inlined asset), so check whether it is a
dev-only dependency and, if so, add the specific submodules as real dependencies. Per the
mobile PR template, call out any new dependency and why.

## Risks and open questions

- **Performance ceiling:** thousands of edges and nodes redrawn per tick on the JS thread.
  Mitigate with batched paths, sprite atlas, culling, and settling off-screen. The spike
  exists to find out before committing to the rewrite.
- **Threading:** d3-force is plain JS and not workletized. Options: JS-thread batches;
  a worklet runtime via `react-native-worklets` (needs the sim code bundled as a worklet);
  or precompute-then-animate. Decide with spike data.
- **Text:** Skia text needs a font asset or system font matching; check weight and
  tracking against the theme's chat/note fonts and the font-size setting.
- **Parity volume:** many small behaviours (see checklist) must match or users will
  notice. Treat the checklist as the acceptance list.
- **Gesture-handler 3.x API** differs from older docs; verify against installed types.
- **Not verifiable in the cloud sandbox:** frame rate, gesture feel, haptics and layout on
  the iPhone Duo poses all need a device. Pure layout/filter/hit-test logic is
  unit-testable (`*.test.ts` under the vitest "mobile" project, framework-free modules only).
- Open: keep a "list view" of the graph as a permanent alternative? Cap the rendered
  node count for very large workspaces (progressive disclosure by zoom)?

## Verification

- `cd mobile && npx tsc --noEmit && npx eslint --max-warnings 0 .`; from the repo root
  `npx vitest run mobile shared` for layout, filter, hit-test and hierarchy logic.
- Device checks: 60+ fps pan/zoom on the largest real workspace; no blank graph after
  backgrounding for several minutes; tap/drag accuracy on small nodes; label legibility
  at default and large font sizes; light/dark and accent change; Force ↔ Radial; Duo poses.
