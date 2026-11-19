import { describe, it, expect } from "vitest";
import { hiddenPersonaIds, withoutPersonaNotes } from "./persona-notes";

const base = { showPersonaNotes: false, personaNoteIds: ["n2"] };

describe("persona notes", () => {
  it("hides persona notes", () => {
    expect([...hiddenPersonaIds(base)]).toEqual(["n2"]);
  });

  it("hides nothing once the user shows people's notes", () => {
    expect(hiddenPersonaIds({ ...base, showPersonaNotes: true }).size).toBe(0);
  });

  it("filters a list, and returns the same array when nothing is hidden", () => {
    const notes = [{ id: "n1" }, { id: "n2" }];
    expect(withoutPersonaNotes(notes, hiddenPersonaIds(base))).toEqual([{ id: "n1" }]);
    expect(withoutPersonaNotes(notes, hiddenPersonaIds({ ...base, showPersonaNotes: true }))).toBe(notes);
  });
});
