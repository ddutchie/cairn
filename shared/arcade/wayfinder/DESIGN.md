# Wayfinder — Game Design & World Vision

## What It Is
**Wayfinder** is an open-sea stacked-voxel sailing & island-exploration adventure seeded from your Cairn knowledge graph. Notes become uncharted islands, wikilinks become sea lanes, overdue tasks brew roaming storms, and Today's tasks become cargo to deliver to project harbours before dusk.

## What We're Trying to Achieve
- **Benchmark World Feel:** Responsive boat steering, animated wake/waves, dolphins/whales/turtles, a Charted Waters mini-map (`M`), edge compasses toward active deliveries, and a Ship's Log summary.
- **Island Exploration:** Docking at an island transitions to an on-foot expedition stage with biome skies, parallax ridges, and encounter choices.

## Follow-Up: 3D Engine Integration (`raster3d.ts`)
- Reuse `shared/arcade/pixel/raster3d.ts` (`Framebuffer3D`, `meshFromModel`, `makeCam3D`) to upgrade Wayfinder's **island exploration mode** from 2D parallax strips into a true Z-buffered 3D island stage — letting the captain walk/explore real 3D biome terrain with 3D voxel trees, shrines, ruins, and foes rendered in the same chunky low-res 3D style.
