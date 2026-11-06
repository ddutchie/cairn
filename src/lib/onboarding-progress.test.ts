// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOnboardingInProgress,
  clearPendingImport,
  isOnboardingInProgress,
  markOnboardingInProgress,
  readPendingImport,
  savePendingImport,
} from "./onboarding-progress";

const project = (id: string) => ({ id, name: id.toUpperCase(), noteCount: 2 });

describe("pending import", () => {
  beforeEach(() => localStorage.clear());

  it("comes back after a restart", () => {
    savePendingImport([project("a"), project("b")]);
    expect(readPendingImport([{ id: "a" }, { id: "b" }])).toEqual([project("a"), project("b")]);
  });

  it("leaves out projects that no longer exist", () => {
    savePendingImport([project("a"), project("b")]);
    expect(readPendingImport([{ id: "b" }])).toEqual([project("b")]);
  });

  it("is gone once undone or when onboarding finishes", () => {
    savePendingImport([project("a")]);
    clearPendingImport();
    expect(readPendingImport([{ id: "a" }])).toEqual([]);

    savePendingImport([project("a")]);
    clearOnboardingInProgress();
    expect(readPendingImport([{ id: "a" }])).toEqual([]);
  });

  it("treats a damaged value as nothing pending", () => {
    localStorage.setItem("onboardingPendingImport", "{not json");
    expect(readPendingImport([{ id: "a" }])).toEqual([]);
    localStorage.setItem("onboardingPendingImport", '{"id":"a"}');
    expect(readPendingImport([{ id: "a" }])).toEqual([]);
  });

  it("never throws when storage is unavailable", () => {
    const fail = () => { throw new Error("storage unavailable"); };
    const spies = [
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(fail),
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(fail),
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(fail),
    ];
    try {
      expect(() => {
        markOnboardingInProgress();
        savePendingImport([project("a")]);
        clearPendingImport();
        clearOnboardingInProgress();
      }).not.toThrow();
      expect(isOnboardingInProgress()).toBe(false);
      expect(readPendingImport([{ id: "a" }])).toEqual([]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
