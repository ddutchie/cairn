import { describe, it, expect } from "vitest";
import { describeSuggestedAction, normalizeSuggestedAction } from "./suggested-action-text";
import type { SuggestedAction } from "@/types";

const lookups = {
  noteTitle: (id: string | undefined) => (id === "n1" ? "Alpha Note" : id === "n2" ? "Beta Note" : undefined),
  cardTitle: (id: string | undefined) => (id === "c1" ? "Ship it" : undefined),
};

describe("describeSuggestedAction", () => {
  it("labels a fully-populated wikilink action", () => {
    const a = { type: "add_wikilink", sourceNoteId: "n1", sourceTitle: "Alpha Note", targetTitle: "Beta Note", reason: "r" } as SuggestedAction;
    expect(describeSuggestedAction(a, lookups)).toBe('Add [[Beta Note]] → "Alpha Note"');
  });

  it("resolves missing titles from the store by ID", () => {
    const a = { type: "link_note_note", sourceNoteId: "n1", targetNoteId: "n2", reason: "r" } as unknown as SuggestedAction;
    expect(describeSuggestedAction(a, lookups)).toBe('Link "Alpha Note" ↔ "Beta Note"');
  });

  it("resolves card titles for note→card links", () => {
    const a = { type: "link_note_card", noteId: "n1", cardId: "c1", reason: "r" } as unknown as SuggestedAction;
    expect(describeSuggestedAction(a, lookups)).toBe('Link "Alpha Note" → "Ship it"');
  });

  it("falls back to the raw ID when the store has no match", () => {
    const a = { type: "link_note_note", sourceNoteId: "n9", targetNoteId: "n2", reason: "r" } as unknown as SuggestedAction;
    expect(describeSuggestedAction(a, lookups)).toBe('Link "n9" ↔ "Beta Note"');
  });

  it("never returns blank for an unknown action type", () => {
    const a = { type: "link_notes", source: "n1", target: "n2", reason: "r" } as unknown as SuggestedAction;
    const label = describeSuggestedAction(a, lookups);
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).toContain("link_notes");
  });

  it("never returns blank without lookups either", () => {
    const a = { type: "add_tag", reason: "r" } as unknown as SuggestedAction;
    expect(describeSuggestedAction(a).trim().length).toBeGreaterThan(0);
  });
});

describe("normalizeSuggestedAction", () => {
  it("infers link_note_card from cardId + targetNoteId with no type", () => {
    const raw = {
      cardId: "c1", cardTitle: "Ship it", nodeType: "card",
      reason: "r", targetNoteId: "n2", targetTitle: "Beta Note",
    } as unknown as SuggestedAction;
    const out = normalizeSuggestedAction(raw) as unknown as Record<string, unknown>;
    expect(out.type).toBe("link_note_card");
    expect(out.noteId).toBe("n2");
    expect(out.noteTitle).toBe("Beta Note");
    expect(describeSuggestedAction(out as SuggestedAction, lookups)).toBe('Link "Beta Note" → "Ship it"');
  });

  it("infers link_note_note from sourceNoteId + targetNoteId with no type", () => {
    const raw = {
      noteId: "n1", nodeType: "note", reason: "r",
      sourceNoteId: "n1", sourceTitle: "Alpha Note",
      targetNoteId: "n2", targetTitle: "Beta Note",
    } as unknown as SuggestedAction;
    const out = normalizeSuggestedAction(raw);
    expect(out.type).toBe("link_note_note");
    expect(describeSuggestedAction(out, lookups)).toBe('Link "Alpha Note" ↔ "Beta Note"');
  });

  it("infers link_note_card from cardId + nodeId(nodeType note) with no type", () => {
    const raw = {
      cardId: "c1", cardTitle: "Ship it", nodeId: "n1",
      nodeTitle: "Alpha Note", nodeType: "note", reason: "r",
      sourceNoteId: "n1", sourceTitle: "Alpha Note",
    } as unknown as SuggestedAction;
    const out = normalizeSuggestedAction(raw) as unknown as Record<string, unknown>;
    expect(out.type).toBe("link_note_card");
    expect(out.noteId).toBe("n1");
    expect(describeSuggestedAction(out as SuggestedAction, lookups)).toBe('Link "Alpha Note" → "Ship it"');
  });

  it("leaves a valid typed action untouched", () => {
    const raw = { type: "add_tag", nodeId: "n1", nodeTitle: "Alpha Note", nodeType: "note", tagName: "hiring", reason: "r" } as unknown as SuggestedAction;
    expect(normalizeSuggestedAction(raw)).toEqual(raw);
  });
});
