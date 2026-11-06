import { describe, expect, it } from "vitest";
import { findBottleneck } from "./board-bottleneck";

const columns = [
  { id: "b", name: "Backlog", type: "backlog" },
  { id: "t", name: "Todo", type: "todo" },
  { id: "d", name: "Done", type: "done" },
];
const cards = (b: number, t: number, d = 0) => [
  ...Array(b).fill({ columnId: "b" }),
  ...Array(t).fill({ columnId: "t" }),
  ...Array(d).fill({ columnId: "d" }),
];

describe("findBottleneck", () => {
  it("does not call a new board's cards a bottleneck", () => {
    expect(findBottleneck(columns, cards(1, 1))).toBeNull();
    expect(findBottleneck(columns, cards(2, 0))).toBeNull();
  });

  it("needs one column to hold most of the open cards", () => {
    expect(findBottleneck(columns, cards(3, 3))).toBeNull();
    expect(findBottleneck(columns, cards(4, 1))).toEqual({ name: "Backlog", count: 4 });
  });

  it("ignores done cards", () => {
    expect(findBottleneck(columns, cards(1, 0, 9))).toBeNull();
  });
});
