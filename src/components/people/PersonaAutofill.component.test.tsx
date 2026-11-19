import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { peopleClient } from "@/lib/ipc/people";
import { PersonPage } from "./PersonPage";
import type { PersonPage as PageModel } from "../../../shared/types/people-view";

const page = {
  person: { id: "p1", workspaceId: "w", name: "Ana", aliases: [], emails: [], relationship: [], status: "confirmed", provenance: "explicit", stage: "active", isMe: false, agentPrivate: false },
  relations: [], timeline: [], persona: { id: "n1", title: "Ana", content: "Role: Senior Engineer" },
  meetings: [], mentions: [], ownedCards: [],
} as unknown as PageModel;

const updatePerson = vi.fn().mockResolvedValue(undefined);
beforeEach(() => { updatePerson.mockClear(); useCairnStore.setState({ updatePerson } as never); });

describe("persona autofill", () => {
  it("proposes, lets the user tick, and applies only the ticked fields", async () => {
    vi.spyOn(peopleClient, "autofill").mockResolvedValue({ proposals: [
      { field: "title", value: "Senior Engineer", quote: "Role: Senior Engineer" },
      { field: "team", value: "Sync", quote: "Sync team", current: "Platform" },
    ] });
    render(<PersonPage page={page} />);
    fireEvent.click(screen.getByRole("button", { name: /Fill details from note/ }));
    await screen.findByLabelText("Proposed details");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    vi.spyOn(peopleClient, "get").mockResolvedValue({ ...page.person } as never);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(updatePerson).toHaveBeenCalledWith("p1", { title: "Senior Engineer" }));
  });

  it("leaves a field alone when it changed since the review", async () => {
    vi.spyOn(peopleClient, "autofill").mockResolvedValue({ proposals: [{ field: "title", value: "Senior Engineer", quote: "Role: Senior Engineer" }] });
    vi.spyOn(peopleClient, "get").mockResolvedValue({ ...page.person, title: "Staff Engineer" } as never);
    render(<PersonPage page={page} />);
    fireEvent.click(screen.getByRole("button", { name: /Fill details from note/ }));
    await screen.findByLabelText("Proposed details");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("status")).toHaveTextContent("changed meanwhile");
    expect(updatePerson).not.toHaveBeenCalled();
  });

  it("explains when nothing can be done", async () => {
    vi.spyOn(peopleClient, "autofill").mockResolvedValue({ skipped: "private" });
    render(<PersonPage page={page} />);
    fireEvent.click(screen.getByRole("button", { name: /Fill details from note/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("private");
  });
});
