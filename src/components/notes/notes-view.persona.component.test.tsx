/**
 * Notes view: a live person's persona note stays out of the list while the
 * People layer is on, comes back with the "Show people's notes" toggle, and
 * the list is unchanged with the flag off. Outside Electron the store's loads
 * are no-ops, so state is set directly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Note } from "@/types";
import { NotesView } from "./notes-view";

const note = (id: string, title: string): Note => ({
  id,
  projectId: "pr1",
  workspaceId: "ws1",
  title,
  content: "",
  contentText: "",
  tagIds: [],
  linkedNoteIds: [],
  linkedCardIds: [],
  isPinned: false,
  type: "note",
  folder: "",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  version: 1,
});

function seed() {
  useCairnStore.setState({
    activeWorkspaceId: "ws1",
    activeProjectId: "pr1",
    notes: [note("n1", "Roadmap draft"), note("n2", "Ada Report persona")],
    personaNoteIds: ["n2"],
    showPersonaNotes: false,
  });
}

const renderView = () => render(<NotesView />, { wrapper: TooltipProvider });
const listed = (title: string) => screen.queryAllByText(title).length > 0;

describe("NotesView: persona notes", () => {
  beforeEach(() => seed());

  it("hides a person's persona note", () => {
    renderView();
    expect(listed("Roadmap draft")).toBe(true);
    expect(listed("Ada Report persona")).toBe(false);
  });

  it("shows it again with the Show people's notes toggle", () => {
    renderView();
    fireEvent.click(screen.getByRole("switch", { name: "Show people's notes" }));
    expect(listed("Ada Report persona")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Show people's notes" }));
    expect(listed("Ada Report persona")).toBe(false);
  });

});
