# Tideglass — Game Design & World Vision

## What It Is
**Tideglass** is a *Short Hike*-inspired 3D voxel mountain descent and clockwork island mystery. You play as **the Wick**, an oilskin lighthouse tender starting at the snowy summit beacon and descending through Alpine ridges, Pine Forest, and Ebb Shore over one slow, non-looping day (`calm → wind → squall → ebb`).

## What We're Trying to Achieve
- **Chunky Low-Res 3D Traversal:** Real perspective 3D (`shared/arcade/pixel/raster3d.ts`) with a behind-the-shoulder camera looking down the mountain toward the ocean horizon, Z-buffered terrain & voxel meshes, and **hop + oilskin gliding** (`Space` / `J`) off terraced cliffs.
- **Readable Island Geography:**
  - **Conical Island Silhouette:** The summit falls away not just north-to-south, but also toward rocky east/west sea cliffs so the ocean wraps visibly around the island.
  - **4 Distinct Zones:** `PEAK` (snow & lighthouse overlook), `ALPINE` (slate ridges, radio mast, tide mill), `FOREST` (dense pine groves, harbour hut), and `SHORE` (sandy coves, ferry dock, sunken ebb flats, lens vault).
  - **Environmental Storytelling:** Switchback trails marked by stone cairns and fork signposts, a wooden bridge over the mill sluice channel, and a sweeping lighthouse beam during the squall.
- **No Grind, No Quest Markers:** A **Brass Notebook** (`L`) records what you witness and overhear; five interlocking secrets lead to awakening the Tideglass Lens Vault.
