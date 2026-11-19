/**
 * The migration panel: nothing is applied by opening it or previewing, only the
 * ticked candidates are sent, and the result is summarised in plain words.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MigrationInventory, MigrationResult, PersonaCandidate } from "../../../shared/types/people-migration";

const inventory = vi.fn();
const apply = vi.fn();
vi.mock("@/lib/ipc/people", () => ({
  peopleClient: { migrationInventory: (...a: unknown[]) => inventory(...a), migrationApply: (...a: unknown[]) => apply(...a) },
}));

import { MigrationPanel, summarise } from "./MigrationPanel";

const cand = (noteId: string, name: string, extra: Partial<PersonaCandidate> = {}): PersonaCandidate => ({
  noteId, projectId: "p", title: name, folder: "People", tags: [], confidence: "medium", score: 3, reasons: ["in a people folder"],
  name, aliases: [], emails: [], archived: false, ambiguousWith: [], action: "create", suggestedAliases: [], linkedFromNotes: 0, ownedItems: 0, ...extra,
});
const inv = (over: Partial<MigrationInventory> = {}): MigrationInventory => ({
  workspaceId: "ws1",
  counts: { notesScanned: 3, personaCandidates: 3, highConfidence: 0, meetingNotes: 1, ownedChecklistItems: 0, openOwnedChecklistItems: 0, archivedCandidates: 0, existingPeople: 0, collisions: 0, ambiguousNames: 0 },
  personas: [
    cand("a", "Ana Ruiz", { suggestedAliases: ["Ana"] }),
    cand("b", "Sam Whitfield", { action: "skip", skipReason: "ambiguous_name" }),
    cand("c", "Hiring Overview", { confidence: "low", score: 2 }),
  ],
  meetings: [{ noteId: "m", projectId: "p", title: "Sync", folder: "", via: ["body_line"], date: null, alreadyMeeting: false, attendees: [{ text: "Ana Ruiz", resolution: "candidate", candidateNoteIds: ["a"] }, { text: "Zed", resolution: "unknown" }] }],
  owners: [], ambiguousShortNames: [{ text: "Chris", candidateNoteIds: ["x", "y"] }],
  ...over,
});
const result = (over: Partial<MigrationResult> = {}): MigrationResult => ({
  dryRun: true, applied: true, personas: [{ noteId: "a", outcome: "created", personId: "p1" }], meetings: [], frontmatterNotes: [],
  index: { mentionsBefore: 0, mentionsAfter: 2, ownedItemsBefore: 0, ownedItemsAfter: 3 }, ...over,
});

beforeEach(() => {
  inventory.mockReset().mockResolvedValue(inv());
  apply.mockReset().mockResolvedValue(result());
  useCairnStore.setState({ activeWorkspaceId: "ws1", refreshPeople: vi.fn().mockResolvedValue(undefined) } as never);
});

describe("MigrationPanel", () => {
  it("scans on open without applying anything, ticking the confident ones and leaving weak and skipped ones off", async () => {
    render(<MigrationPanel onClose={() => {}} />, { wrapper: TooltipProvider });
    await screen.findByText("Ana Ruiz");
    expect(inventory).toHaveBeenCalledWith("ws1");
    expect(apply).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Ana Ruiz/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Hiring Overview/) as HTMLInputElement).checked).toBe(false);
    const sam = screen.getByLabelText(/Sam Whitfield/) as HTMLInputElement;
    expect(sam.disabled).toBe(true);
    expect(screen.getByText(/rename one first/)).toBeTruthy();
    expect(screen.getByText(/“Chris” fits more than one person/)).toBeTruthy();
  });

  it("previews as a dry run, then applies only what is ticked, with accepted aliases", async () => {
    render(<MigrationPanel onClose={() => {}} />, { wrapper: TooltipProvider });
    await screen.findByText("Ana Ruiz");
    fireEvent.click(screen.getByLabelText(/Also answer to “Ana”/));
    fireEvent.click(screen.getByLabelText(/Hiring Overview/));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenLastCalledWith("ws1", { personas: [{ noteId: "a", aliases: ["Ana"] }, { noteId: "c", aliases: [] }], meetings: ["m"] }, true);
    expect(await screen.findByText(/nothing has changed yet/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1][2]).toBe(false);
    expect(await screen.findByRole("region", { name: "Applied" })).toBeTruthy();
  });

  it("unticking everything disables Apply", async () => {
    render(<MigrationPanel onClose={() => {}} />, { wrapper: TooltipProvider });
    await screen.findByText("Ana Ruiz");
    fireEvent.click(screen.getByLabelText(/Ana Ruiz/));
    fireEvent.click(screen.getByLabelText(/Sync/));
    expect((screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("summarise", () => {
  it("says what happened in plain words", () => {
    expect(summarise(result({
      personas: [{ noteId: "a", outcome: "created" }, { noteId: "b", outcome: "linked" }, { noteId: "c", outcome: "skipped" }],
      meetings: [{ noteId: "m", outcome: "captured", attendees: [], suggested: [], unmatched: ["Zed"] }],
    }))).toEqual([
      "1 new person", "1 existing person linked to their note", "1 skipped", "1 meeting with attendees",
      "1 listed name matches nobody and stays as text", "2 links to people", "3 action items assigned",
    ]);
    expect(summarise(result({ personas: [], index: { mentionsBefore: 1, mentionsAfter: 1, ownedItemsBefore: 1, ownedItemsAfter: 1 } }))).toEqual(["Nothing to change"]);
  });
});
