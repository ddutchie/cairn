/** Note drafts: round-trip, clear, corrupt values, per-workspace reset, and the differs check. */
import { describe, it, expect, vi } from "vitest";

import { loadNoteDraft, saveNoteDraft, clearNoteDraft, clearWorkspaceDrafts, draftDiffers, type DraftStore } from "./note-draft";

// vi.mock is hoisted above the imports; keeps expo-sqlite out of the test.
vi.mock("@/db", () => ({ getMeta: () => null, setMeta: () => {}, deleteMetaPrefix: () => {} }));

function memoryStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    deletePrefix: (p) => {
      for (const k of [...map.keys()]) if (k.startsWith(p)) map.delete(k);
    },
  };
}

describe("note drafts", () => {
  it("round-trips a draft per note", () => {
    const s = memoryStore();
    saveNoteDraft("ws", "n1", { title: "T", body: "B" }, s);
    expect(loadNoteDraft("ws", "n1", s)).toMatchObject({ title: "T", body: "B" });
    expect(loadNoteDraft("ws", "n2", s)).toBeNull();
    expect(loadNoteDraft("other", "n1", s)).toBeNull();
  });

  it("clears to no draft", () => {
    const s = memoryStore();
    saveNoteDraft("ws", "n1", { title: "T", body: "B" }, s);
    clearNoteDraft("ws", "n1", s);
    expect(loadNoteDraft("ws", "n1", s)).toBeNull();
  });

  it("clears one workspace's drafts and keeps the others", () => {
    const s = memoryStore();
    saveNoteDraft("ws", "n1", { title: "T", body: "B" }, s);
    saveNoteDraft("ws", "n2", { title: "T", body: "B" }, s);
    saveNoteDraft("ws2", "n1", { title: "T", body: "B" }, s);
    clearWorkspaceDrafts("ws", s);
    expect(loadNoteDraft("ws", "n1", s)).toBeNull();
    expect(loadNoteDraft("ws", "n2", s)).toBeNull();
    expect(loadNoteDraft("ws2", "n1", s)).not.toBeNull();
  });

  it("ignores corrupt or wrong-shaped values", () => {
    const s = memoryStore();
    s.map.set("note_draft.ws.n1", "{not json");
    s.map.set("note_draft.ws.n2", JSON.stringify({ title: 1 }));
    expect(loadNoteDraft("ws", "n1", s)).toBeNull();
    expect(loadNoteDraft("ws", "n2", s)).toBeNull();
  });

  it("only treats a draft as worth restoring when it changes the note", () => {
    const d = { title: "T", body: "B", savedAt: "" };
    expect(draftDiffers(d, { title: "T", content: "B" })).toBe(false);
    expect(draftDiffers(d, { title: "T", content: "B2" })).toBe(true);
    expect(draftDiffers({ ...d, title: "" }, { title: null, content: "B" })).toBe(false);
  });
});
