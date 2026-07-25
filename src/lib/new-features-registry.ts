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
 * Compute which features to surface in the "What's New" modal.
 *
 * - When `forceOpen` is true (e.g. opened from Settings), return the entire
 *   registry so the user can browse all releases.
 * - Otherwise, return only the unseen features belonging to the latest
 *   version in the registry. This is the boot-time gate: the modal/tour only
 *   appears when there is something new the user hasn't acknowledged yet.
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
  const latestVersion = registry[registry.length - 1].version;
  return registry.filter(
    (f) => f.version === latestVersion && !seenFeatures.includes(f.id),
  );
}
