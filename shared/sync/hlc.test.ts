import { describe, it, expect } from "vitest";
import { encodeHlc, decodeHlc, compareHlc } from "./hlc";

describe("hlc decode validation", () => {
  it("round-trips a valid stamp", () => {
    const s = encodeHlc({ physical: 123456, counter: 7, deviceId: "dev_1" });
    expect(decodeHlc(s)).toEqual({ physical: 123456, counter: 7, deviceId: "dev_1" });
  });

  it("preserves deviceIds containing colons", () => {
    const s = encodeHlc({ physical: 1, counter: 1, deviceId: "a:b:c" });
    expect(decodeHlc(s).deviceId).toBe("a:b:c");
  });

  it("throws on malformed stamps instead of returning NaN", () => {
    expect(() => decodeHlc("not-an-hlc")).toThrow(/Malformed HLC/);
    expect(() => decodeHlc("zzzz:0001:dev")).toThrow(/Malformed HLC/);
    expect(() => decodeHlc("0001::dev")).toThrow(/Malformed HLC/);
    expect(() => decodeHlc("0001:0001")).toThrow(/Malformed HLC/); // no deviceId
    expect(() => decodeHlc("1:0001:dev")).toThrow(/Malformed HLC/); // non-canonical physical width
    expect(() => decodeHlc("000000000001:10000:dev")).toThrow(/Malformed HLC/); // counter overflow
    expect(() => decodeHlc("000000000001:0001:")).toThrow(/Malformed HLC/); // empty deviceId
    expect(() => decodeHlc("00000000000A:0001:dev")).toThrow(/Malformed HLC/); // non-canonical uppercase
  });

  it("compareHlc orders by physical then counter then deviceId", () => {
    const a = encodeHlc({ physical: 10, counter: 0, deviceId: "a" });
    const b = encodeHlc({ physical: 10, counter: 1, deviceId: "a" });
    const c = encodeHlc({ physical: 11, counter: 0, deviceId: "a" });
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, c)).toBeLessThan(0);
    expect(compareHlc(c, a)).toBeGreaterThan(0);
  });
});
