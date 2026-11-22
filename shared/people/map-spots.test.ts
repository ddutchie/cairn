import { describe, it, expect } from "vitest";
import { groupBySpot, spotOf } from "./map-spots";
import type { PersonSummary } from "../types/people-view";

const person = (id: string, name: string, timezone?: string, location?: string) =>
  ({ id, name, timezone, location } as unknown as PersonSummary);

describe("map spots", () => {
  it("puts someone on their zone's principal city", () => {
    expect(spotOf(person("1", "Ana", "Europe/Madrid"))?.label).toBe("Madrid");
  });
  it("prefers their own city when it agrees with the zone", () => {
    expect(spotOf(person("1", "Ana", "Europe/London", "Manchester, UK"))?.label).toBe("Manchester");
  });
  it("ignores a stale city that disagrees with the zone", () => {
    expect(spotOf(person("1", "Ana", "Europe/London", "Sydney"))?.label).toBe("London");
  });
  it("groups people who share a spot and lists the rest as unplaced by name", () => {
    const { groups, unplaced } = groupBySpot([
      person("1", "Ana", "Europe/Madrid"),
      person("2", "Bo", "Europe/Madrid"),
      person("3", "Zed"),
      person("4", "Cy", "Not/AZone"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].people.map((p) => p.name)).toEqual(["Ana", "Bo"]);
    expect(unplaced.map((p) => p.name)).toEqual(["Cy", "Zed"]);
  });
});
