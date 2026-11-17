import { describe, expect, it } from "vitest";
import { capResult } from "./external";

describe("capResult", () => {
  it("leaves a result alone when there is no cap or it fits", () => {
    expect(capResult("abc")).toBe("abc");
    expect(capResult("abc", 3)).toBe("abc");
  });

  it("cuts a long result and says how much was kept", () => {
    const out = capResult("x".repeat(50), 10);
    expect(out.startsWith("x".repeat(10) + "\n")).toBe(true);
    expect(out).not.toContain("x".repeat(11));
    expect(out).toContain("showing 10 of 50 characters");
  });
});
