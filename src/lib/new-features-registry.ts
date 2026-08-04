import newFeaturesData from "@/generated/new-features.json";

export interface NewFeature {
  id: string; // Feature/V key e.g., 'v2.3.0-chat-layout'
  version: string; // e.g. 'v2.3.0'
  title: string;
  category: string;
  description: string;
  highlights: string[];
}

/**
 * The What's New registry, generated from the curated `scripts/features.config.js`
 * by `scripts/generate-features.js` into `src/generated/new-features.json` (baked
 * into the static export; run in `build.js` and the `dev` script — same pattern as
 * `licenses.json`). To announce a new major feature, add an entry to
 * `scripts/features.config.js`, not here.
 */
export const NEW_FEATURES_REGISTRY: NewFeature[] = (newFeaturesData.registry ?? []) as NewFeature[];

/**
 * Reduce a full version tag to its minor line, e.g. "v2.6.1" → "v2.6".
 * Condensed whole-major tags ("v0.x", "v1.x") reduce to the major alone ("v0"),
 * and condensed minor tags ("v2.5.x") reduce to the minor ("v2.5").
 * Feature gating is per minor so every unseen patch release in the current
 * line surfaces at boot (2.6.0 + 2.6.1 both show), while older minors stay
 * hidden until the user browses from Settings.
 */
export function minorOf(version: string): string {
  const parts = version.split(".");
  if (parts[1] === "x") return parts[0];
  return parts.slice(0, 2).join(".");
}

/** True for a condensed release card ("v0.x", "v2.5.x") — never auto-shown. */
function isCondensed(version: string): boolean {
  return version.endsWith(".x");
}

/**
 * Compute which features to surface in the "What's New" modal.
 *
 * - When `forceOpen` is true (e.g. opened from Settings), return the entire
 *   registry so the user can browse all releases.
 * - Otherwise, return only the UNSEEN features belonging to the newest MINOR
 *   version in the registry. This is the boot-time gate: the modal/tour only
 *   appears when there is something new the user hasn't acknowledged yet.
 *
 * Gating by minor (not the exact latest patch) means a headline feature that
 * ships in 2.6.1 still shows to users who upgraded mid-minor, while the
 * `seenFeatures` filter ensures a user who already saw 2.6.0's entries only
 * sees the new 2.6.1 ones — never a re-show of what they dismissed.
 *
 * Pure function — shared by NewFeatureModal and the boot logic in page.tsx so
 * the gating cannot drift between the two call sites.
 */
export function getUnseenLatestFeatures(
  registry: NewFeature[],
  seenFeatures: string[],
  forceOpen = false,
): NewFeature[] {
  if (forceOpen) return registry;
  if (registry.length === 0) return [];
  // The active minor comes from the newest FULL release — condensed cards can
  // never define it, no matter where they sit in the registry order.
  const active = registry.filter((f) => !isCondensed(f.version));
  if (active.length === 0) return [];
  const latestMinor = minorOf(active[active.length - 1].version);
  return registry.filter(
    (f) =>
      !isCondensed(f.version) &&
      minorOf(f.version) === latestMinor &&
      !seenFeatures.includes(f.id),
  );
}
