# Basecamp — Game Design & World Vision

## What It Is
**Basecamp** is a cozy stacked-voxel colony & clockwork valley mystery seeded directly from your Cairn workspace. Each active project becomes a **Lodge** with a resident **Settler**; overdue tasks become **Twilight Brambles** to clear for timber and sparks.

## What We're Trying to Achieve
- **A Living Valley Shaped by Your Work:**
  - **Central Hearthfire Plaza:** Warm cobbled gathering ring with log benches where settlers warm up at night and where the Warden lights their lantern ember.
  - **Distinct Quadrant Landmarks:**
    - **North:** Raised 3D stone plateau with steps leading up to the **Fifth Cairn**.
    - **North-West:** Sunken mossy creek & **Mill Sluice Gate** controlling the water level downstream.
    - **South-East:** **Moonlit Pond** & sunken causeway revealing a brass-bound chest when the sluice opens at night.
    - **East & South-West:** **Bronze Bell Bluff** (warm autumn clearing) and **Shortwave Radio Outpost** (slate flagstones).
- **Clockwork Two-Minute Day (`dawn → noon → dusk → night`):** Settlers follow daily schedules between landmarks, offering contextual clues for 5 interlocking secrets recorded in the **Warden Field Log** (`L`).

## The Loop: Keep the Light
Basecamp is a camp-survival loop now, so it plays differently from Tideglass's one-day mystery.
- **Day (65% of a two-minute cycle):** clear brambles (open tasks) for timber, upgrade lodges into workshops (2 wood), and **feed the hearth** (1 wood = +25 fuel). The hearth burns all the time, faster at night. Timber is the tension: growth or fuel.
- **Dusk:** a countdown to dark. Carry an ember from the hearth to the three watchfires, The west and east ones stand between two lodges each, and the south one guards the southern lodge.
- **Night (35%):** the **Twilight** comes out of the treeline as wisps, more each night, plus one for every second bramble you left standing. Each wisp heads for the nearest lodge or the hearth.
  - Lit watchfires burn wisps within 54 units, and workshop settlers stay on watch at their lodge (34 units). The Warden's ember swats them on contact.
  - A wisp that reaches a workshop **dims it** back to a plain lodge. At a plain lodge it **regrows a bramble**. At the hearth it **drains 12 fuel**.
- **Dawn:** the night is counted (100 × nights + 50 per workshop still standing). Watchfires burn out, workshops turn out timber and a spark, deadfall lands at the forest edge, and brambles regrow (one, plus one per overdue task, up to 3).
- **The hearth going out ends the camp.** Seeing 5 nights through is +1000 and *the camp endures*. Play carries on for score.
- The valley's secrets (sluice and pond chest, dusk bell and radio, the Fifth Cairn) are side paths that pay in sparks and score.
- Night is drawn as real darkness: an 8-pixel light map quantised to 6 levels and merged into runs (a few hundred rects a frame), with pools around every light.
