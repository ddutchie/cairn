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

## The Loop Between the Beats
The day's clockwork beats (sluice lock, crate move, flare, squall, ebb) are minutes apart. What fills the time between them:
- **Sea glass (24 pieces)** sits on cliff lips and ridge tops off the trail, with a quota per altitude band. Taking the scenic line (hop off a ledge, glide to the next) is how you find it.
- **Glide stamina.** The oilskin glides for 75 frames and refills on the ground. Every 4 pieces of sea glass add 30 frames, which opens longer lines down the mountain. Glide is the reward for exploring, and exploring is how you get more glide.
- **Touch has a HOP button** (tap to hop, hold to glide), so phones get the same traversal as keyboards.

## Leads, Not Markers
- A **compass strip** under the HUD shows only places the Wick *knows*: seen within 210 units, mentioned by an islander, or read in the hut ledger. Each NPC teaches the places they talk about.
- A lead **glows** when its moment is near (the mill before the lock, the mast during the flare, the lamp before the squall, the flats at ebb), so the clockwork reads without a quest log.
- The HUD's second row names the **next beat you know about** and its time (`SLUICE LOCKS 2:38`).

## The Shore
- The lowest terrace is a **beach** that shelves into the sea. The Wick can't swim: open water blocks, but tide pools and the wet edge can be waded (`isSea` averages the ground over a few steps).
- The trail's last stretch is a **causeway** under water until ebb, shown as stepping stones when bared. It's only bared if the sluice was kept open, so jamming the mill is what makes the flats reachable.

## Look
- The ground follows altitude (sand, dune grass, forest, meadow, slate, snow) with soft noise patches, grain, strata bands on cliffs, and surf on the waterline. There's no checkerboard.
- The light changes with the phase (calm, warm wind, a blue squall, violet ebb), and so do the sea's colour and swell.
- Props between the camera and the Wick are left out so the lighthouse never hides them.
