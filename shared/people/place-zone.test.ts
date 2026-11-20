import { describe, it, expect } from "vitest";
import "./place-data";
import { cleanProfileFieldWithPlaces, placeInfo, searchPlaces, searchZones, zoneForPlace } from "./place-zone";
import { ZONE_COORDS } from "./zone-coords";
import { zoneOffsetMinutes } from "./zones";

describe("zoneForPlace", () => {
  it.each([
    ["San Francisco", "America/Los_Angeles"],
    ["San Francisco, CA", "America/Los_Angeles"],
    ["San Francisco CA", "America/Los_Angeles"],
    ["SF Bay Area", "America/Los_Angeles"],
    ["Montreal", "America/Toronto"],
    ["Montréal, QC, Canada", "America/Toronto"],
    ["Vancouver, BC", "America/Vancouver"],
    ["London, Ontario", "America/Toronto"],
    ["London, UK", "Europe/London"],
    ["Berlin, Germany", "Europe/Berlin"],
    ["Greater Boston", "America/New_York"],
    ["Bengaluru, India", "Asia/Kolkata"],
    ["Texas", "America/Chicago"],
    ["Germany", "Europe/Berlin"],
    ["Nairobi", "Africa/Nairobi"],
    ["Portland, OR", "America/Los_Angeles"],
    ["Austin, Texas, USA", "America/Chicago"],
    ["Remote, Germany", "Europe/Berlin"],
  ])("%s", (place, zone) => expect(zoneForPlace(place)).toBe(zone));

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf, constructor"])("treats %s as an unknown place, not an alias", (place) => {
    expect(zoneForPlace(place)).toBeNull();
    expect(searchPlaces(place)).toEqual([]);
    expect(cleanProfileFieldWithPlaces("timezone", place).error).toMatch(/isn't a time zone/);
  });

  it("returns null for places it does not know and for multi-zone countries", () => {
    expect(zoneForPlace("Narnia")).toBeNull();
    expect(zoneForPlace("USA")).toBeNull();
    expect(zoneForPlace("")).toBeNull();
    expect(zoneForPlace(undefined)).toBeNull();
  });

  it("gives a city its own position, and none for a country", () => {
    const [lat, lon] = placeInfo("San Francisco, CA")!.coords!;
    expect(lat).toBeCloseTo(37.8, 0);
    expect(lon).toBeCloseTo(-122.4, 0);
    expect(placeInfo("Germany")!.coords).toBeUndefined();
  });

  it("only names zones the runtime knows and the map can place", () => {
    const names = ["San Francisco", "Montreal", "Kyiv", "Honolulu", "Ho Chi Minh City", "Tokyo", "Perth", "St Johns"];
    for (const n of names) {
      const z = zoneForPlace(n)!;
      expect(zoneOffsetMinutes(z, new Date())).not.toBeNull();
      expect(ZONE_COORDS[z], z).toBeDefined();
    }
  });
});

describe("cleanProfileField with a place as time zone", () => {
  it("stores the zone for a city and still rejects nonsense", () => {
    expect(cleanProfileFieldWithPlaces("timezone", "Montreal")).toEqual({ value: "America/Toronto" });
    expect(cleanProfileFieldWithPlaces("timezone", "Europe/Berlin")).toEqual({ value: "Europe/Berlin" });
    expect(cleanProfileFieldWithPlaces("timezone", "Narnia").error).toMatch(/isn't a time zone/);
  });
});

describe("suggestions", () => {
  it("completes a city, biggest first, and narrows with a state or country", () => {
    const sf = searchPlaces("san fr");
    expect(sf[0]).toMatchObject({ label: "San Francisco, California, US", zone: "America/Los_Angeles" });
    expect(searchPlaces("portland, or")[0].label).toBe("Portland, Oregon, US");
    expect(searchPlaces("sf bay area")[0].zone).toBe("America/Los_Angeles");
    expect(searchPlaces("montr")[0].zone).toBe("America/Toronto");
    expect(searchPlaces("s")).toEqual([]); // too short to be useful
    expect(searchPlaces("zzzz")).toEqual([]);
  });

  it("completes IANA zone names by their city part first", () => {
    expect(searchZones("los")[0]).toBe("America/Los_Angeles");
    expect(searchZones("europe/ber")).toContain("Europe/Berlin");
    expect(searchZones("x")).toEqual([]);
  });
});
