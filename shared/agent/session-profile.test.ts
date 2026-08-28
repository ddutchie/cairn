import { describe, expect, it } from "vitest";
import { selectSessionProfile } from "./session-profile";

describe("selectSessionProfile", () => {
  it("requires an explicit profile for a new session", () => {
    expect(selectSessionProfile(undefined, undefined)).toEqual({
      error: "A profile is required when creating a session.",
    });
  });

  it("uses persisted metadata over the request", () => {
    expect(selectSessionProfile("coding", "coding")).toEqual({ profile: "coding" });
    expect(selectSessionProfile("automation-dev", undefined)).toEqual({ profile: "automation-dev" });
  });

  it("rejects changing a persisted profile", () => {
    expect(selectSessionProfile("chat", "coding").error).toContain("cannot be changed");
  });
});
