import { afterEach, describe, expect, it } from "vitest";
import { historyManager, type Command } from "./history";

afterEach(() => historyManager.clear());

const failing = (which: "undo" | "redo"): Command => ({
  label: "flaky",
  undo: async () => { if (which === "undo") throw new Error("undo failed"); },
  redo: async () => { if (which === "redo") throw new Error("redo failed"); },
});

describe("historyManager", () => {
  it("keeps a command undoable when its undo fails", async () => {
    historyManager.push(failing("undo"));
    await expect(historyManager.undo()).rejects.toThrow("undo failed");
    expect(historyManager.canUndo).toBe(true);
    expect(historyManager.canRedo).toBe(false);
  });

  it("keeps a command redoable when its redo fails", async () => {
    historyManager.push(failing("redo"));
    await historyManager.undo();
    await expect(historyManager.redo()).rejects.toThrow("redo failed");
    expect(historyManager.canRedo).toBe(true);
    expect(historyManager.canUndo).toBe(false);
  });
});
