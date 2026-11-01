/** Note drafts: round-trip, clear, corrupt values, and the differs check. */
import { describe, it, expect, vi } from "vitest";

import { loadNoteDraft, saveNoteDraft, clearNoteDraft, draftDiffers, type DraftStore } from "./note-draft";

// vi.mock is hoisted above the imports; keeps expo-sqlite out of the test.
vi.mock("@/db", () => ({ getMeta: () => null, setMeta: () => {} }));

function memoryStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

describe("note drafts", () => {
  it("round-trips a draft per note", () => {
    const s = memoryStore();
    saveNoteDraft("n1", { title: "T", body: "B" }, s);
    expect(loadNoteDraft("n1", s)).toMatchObject({ title: "T", body: "B" });
    expect(loadNoteDraft("n2", s)).toBeNull();
  });

  it("clears to no draft", () => {
    const s = memoryStore();
    saveNoteDraft("n1", { title: "T", body: "B" }, s);
    clearNoteDraft("n1", s);
    expect(loadNoteDraft("n1", s)).toBeNull();
  });

  it("ignores corrupt or wrong-shaped values", () => {
    const s = memoryStore();
    s.map.set("note_draft.n1", "{not json");
    s.map.set("note_draft.n2", JSON.stringify({ title: 1 }));
    expect(loadNoteDraft("n1", s)).toBeNull();
    expect(loadNoteDraft("n2", s)).toBeNull();
  });

  it("only treats a draft as worth restoring when it changes the note", () => {
    const d = { title: "T", body: "B", savedAt: "" };
    expect(draftDiffers(d, { title: "T", content: "B" })).toBe(false);
    expect(draftDiffers(d, { title: "T", content: "B2" })).toBe(true);
    expect(draftDiffers({ ...d, title: "" }, { title: null, content: "B" })).toBe(false);
  });
});
