import { describe, it, expect } from "vitest";
import { captureColumn } from "./QuickCapture";
import type { BoardColumn } from "@/types";

const col = (id: string, type: BoardColumn["type"], order: number): BoardColumn =>
  ({ id, type, order, name: id, projectId: "p", workspaceId: "w", createdAt: "", updatedAt: "" }) as BoardColumn;

describe("captureColumn", () => {
  it("prefers backlog, then todo, then the left-most column", () => {
    expect(captureColumn([col("t", "todo", 1), col("b", "backlog", 2)])?.id).toBe("b");
    expect(captureColumn([col("d", "done", 0), col("t", "todo", 3)])?.id).toBe("t");
    expect(captureColumn([col("x", "custom", 5), col("y", "custom", 2)])?.id).toBe("y");
    expect(captureColumn([])).toBeUndefined();
  });
});
