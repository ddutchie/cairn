import { describe, expect, it } from "vitest";
import {
  formatBytesBinary,
  formatBytesSI,
  formatCompact,
  formatCompactWithMillion,
  formatDurationMs,
  formatMegabytes,
} from "./number";

/**
 * Pins today's exact rendered strings for every call site A3 replaces.
 * If any expectation fails, the call site must keep its local copy — do not
 * "fix" the expectation to the new output.
 */
describe("shared/format/number", () => {
  it("formatCompact lower keeps k rendering", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1000)).toBe("1k");
    expect(formatCompact(1500)).toBe("1.5k");
    expect(formatCompact(1200)).toBe("1.2k");
    expect(formatCompact(2000)).toBe("2k");
  });

  it("formatCompact upper keeps K rendering", () => {
    expect(formatCompact(999, { upper: true })).toBe("999");
    expect(formatCompact(1000, { upper: true })).toBe("1K");
    expect(formatCompact(1500, { upper: true })).toBe("1.5K");
  });

  it("formatCompactWithMillion keeps M tier, rounding and clamp", () => {
    expect(formatCompactWithMillion(1234000)).toBe("1.2M");
    expect(formatCompactWithMillion(48000)).toBe("48K");
    expect(formatCompactWithMillion(999)).toBe("999");
    expect(formatCompactWithMillion(-5)).toBe("0");
  });

  it("formatMegabytes keeps binary MB rendering", () => {
    expect(formatMegabytes(104857600)).toBe("100 MB");
  });

  it("formatBytesSI keeps decimal SI rendering", () => {
    expect(formatBytesSI(1.5e9)).toBe("1.5 GB");
    expect(formatBytesSI(5e6)).toBe("5 MB");
    expect(formatBytesSI(1500)).toBe("2 KB");
  });

  it("formatBytesBinary keeps truncation-hint rendering", () => {
    expect(formatBytesBinary(500)).toBe("500B");
    expect(formatBytesBinary(2048)).toBe("2.0KB");
    expect(formatBytesBinary(5242880)).toBe("5.0MB");
  });

  it("formatDurationMs keeps elapsed rendering", () => {
    expect(formatDurationMs(45000)).toBe("45s");
    expect(formatDurationMs(125000)).toBe("2m 5s");
    expect(formatDurationMs(3780000)).toBe("1h 3m");
    expect(formatDurationMs(-100)).toBe("0s");
  });
});
