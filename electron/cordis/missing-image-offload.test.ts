import { describe, expect, it } from "vitest";
import { findMissingImageTargets } from "./missing-image-offload";

function sessionOf(events: Record<number, { type: string; content: Array<Record<string, unknown>> }>) {
  return {
    surface: { nodes: Object.keys(events).map(Number) },
    eventAt: (seq: number) => ({ type: events[seq].type, seq }),
    deriveEventMessage: (event: { type: string; seq?: number }) => ({ content: events[(event as { seq: number }).seq].content as never }),
    append: () => undefined,
  };
}

const img = (id: string, offloaded = false) => ({ type: "image", attachment: { attachmentId: id }, ...(offloaded ? { offloaded: true } : {}) });

describe("findMissingImageTargets", () => {
  it("targets only unreadable, not-yet-offloaded images, indexing all image blocks", () => {
    const session = sessionOf({
      3: { type: "user/message", content: [{ type: "text", text: "a" }, img("gone"), img("ok")] },
      5: { type: "assistant/message", content: [img("gone")] },
      7: { type: "tool/result", content: [img("gone", true), img("gone")] },
      9: { type: "user/message", content: [{ type: "text", text: "no images" }] },
    });
    const targets = findMissingImageTargets(session, (id) => id === "ok");
    expect(targets).toEqual([
      { seq: 3, imageIndexes: [0] },
      { seq: 7, imageIndexes: [1] },
    ]);
  });

  it("returns nothing when every image is readable", () => {
    const session = sessionOf({ 1: { type: "user/message", content: [img("ok")] } });
    expect(findMissingImageTargets(session, () => true)).toEqual([]);
  });
});
