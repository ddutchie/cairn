// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOnboardingInProgress,
  clearPendingImport,
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
});
