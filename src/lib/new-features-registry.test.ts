/**
 * Unit tests for getUnseenLatestFeatures — the pure gate shared by
 * NewFeatureModal and the boot logic in page.tsx. It decides which features the
 * "What's New" modal surfaces (and whether the tour is deferred at boot).
 */

import { describe, expect, it } from "vitest";
import { getUnseenLatestFeatures, type NewFeature } from "./new-features-registry";

const feat = (id: string, version: string): NewFeature => ({
  id,
  version,
  title: `Feature ${id}`,
  category: "Test",
  description: "",
  highlights: [],
});

describe("getUnseenLatestFeatures", () => {
  it("returns the entire registry when forceOpen is true (Settings entrypoint)", () => {
    const registry = [feat("a", "v1.0.0"), feat("b", "v2.0.0")];
    expect(getUnseenLatestFeatures(registry, [], true)).toEqual(registry);
  });

  it("returns the entire registry when forceOpen is true even if all are seen", () => {
    const registry = [feat("a", "v1.0.0"), feat("b", "v2.0.0")];
    expect(getUnseenLatestFeatures(registry, ["a", "b"], true)).toEqual(registry);
  });

  it("returns [] for an empty registry", () => {
    expect(getUnseenLatestFeatures([], [])).toEqual([]);
  });

  it("returns only unseen features from the LATEST version", () => {
    const registry = [
      feat("old", "v1.0.0"),
      feat("latest-1", "v2.0.0"),
      feat("latest-2", "v2.0.0"),
    ];
    // Nothing seen — both latest-version features surface; the old one never does.
    const result = getUnseenLatestFeatures(registry, []);
    expect(result.map((f) => f.id)).toEqual(["latest-1", "latest-2"]);
  });

  it("ignores unseen features from OLDER versions", () => {
    const registry = [feat("old", "v1.0.0"), feat("latest", "v2.0.0")];
    // The old feature is unseen but belongs to a previous version — excluded.
    const result = getUnseenLatestFeatures(registry, ["latest"]);
    expect(result).toEqual([]);
  });

  it("filters out already-seen features within the latest version", () => {
    const registry = [
      feat("latest-1", "v2.0.0"),
      feat("latest-2", "v2.0.0"),
    ];
    const result = getUnseenLatestFeatures(registry, ["latest-1"]);
    expect(result.map((f) => f.id)).toEqual(["latest-2"]);
  });

  it("returns [] when every latest-version feature has been seen", () => {
    const registry = [
      feat("latest-1", "v2.0.0"),
      feat("latest-2", "v2.0.0"),
    ];
    expect(getUnseenLatestFeatures(registry, ["latest-1", "latest-2"])).toEqual([]);
  });

  it("derives the latest version from the LAST registry entry, not by string comparison", () => {
    // The function trusts registry order: the latest version is the last entry's
    // version. A higher version number appearing earlier must NOT be treated as latest.
    const registry = [
      feat("higher-but-earlier", "v9.0.0"),
      feat("actual-latest", "v2.0.0"),
    ];
    const result = getUnseenLatestFeatures(registry, []);
    expect(result.map((f) => f.id)).toEqual(["actual-latest"]);
  });
});
