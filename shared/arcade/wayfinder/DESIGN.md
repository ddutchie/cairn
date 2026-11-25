# Wayfinder — Game Design & World Vision

## What It Is
**Wayfinder** is an open-sea stacked-voxel sailing & island-exploration adventure seeded from your Cairn knowledge graph. Notes become uncharted islands, wikilinks become sea lanes, overdue tasks brew roaming storms, and Today's tasks become cargo to deliver to project harbours before dusk.

## What We're Trying to Achieve
- **Benchmark World Feel:** Responsive boat steering, animated wake/waves, dolphins/whales/turtles, a Charted Waters mini-map (`M`), edge compasses toward active deliveries, and a Ship's Log summary.
- **Island Exploration:** Docking at an island dives the camera from the sea down to the captain's shoulder, onto a real Z-buffered 3D island stage, with biome skies and encounter choices.

## The 3D Island Stage (`island3d.ts`)
- **Terrain from the sea map:** the island's ground is sampled from the same terrain the sea view draws, so the island you walk is the island you sailed to, with its neighbours round it.
- **Landing dive:** over `LANDING_FRAMES` the camera drops through the sea fog to the captain; the HUD and the choice card (and their controls) appear at `CONTROLS_AT` of the dive.
- **Graded trail:** a trail spirals from the beach where the boat put in up to the summit shrine, cut and graded into the slope, with one station per card (a pending fork reserves its station at landing).
- **Low-poly scenery:** trees, rocks, ruins, foes and the shrine are voxel models meshed by the shared `raster3d.ts` (`Framebuffer3D`, `meshFromModel`, `makeCam3D`), drawn in the same chunky low-res 3D style.
