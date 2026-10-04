import { describe, it, expect } from "vitest";
import { completedAtAfterMove } from "./card-completion";

const cols = [{ id: "todo", type: "todo" as const }, { id: "done", type: "done" as const }, { id: "done2", type: "done" as const }];

describe("completedAtAfterMove", () => {
  it("stamps on entering done, keeps done→done, clears on leaving", () => {
    const stamped = completedAtAfterMove({ columnId: "todo" }, "done", cols);
    expect(stamped).toMatch(/^\d{4}-/);
    expect(completedAtAfterMove({ columnId: "done", completedAt: "X" }, "done2", cols)).toBe("X");
    expect(completedAtAfterMove({ columnId: "done", completedAt: "X" }, "todo", cols)).toBeUndefined();
    expect(completedAtAfterMove({ columnId: "todo", completedAt: undefined }, "todo", cols)).toBeUndefined();
  });
});
