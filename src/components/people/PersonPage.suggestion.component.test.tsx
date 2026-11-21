/**
 * A suggested person (an attendee name capture made, or an inferred fact)
 * says so on their page, which chat can open directly, and can be confirmed
 * there; a confirmed person shows no banner.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PersonPage } from "./PersonPage";
import type { PersonPage as PersonPageModel } from "../../../shared/types/people-view";

const page = (status: string) => ({
  person: {
    id: "p1", workspaceId: "ws", name: "Robin", aliases: [], emails: [], relationship: [], status,
    provenance: "inferred", isMe: false, agentPrivate: false, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  },
  relations: [], timeline: [], persona: null,
}) as unknown as PersonPageModel;

describe("person page: suggestions", () => {
  it("offers to confirm a suggested person", () => {
    const confirm = vi.fn(async () => {});
    useCairnStore.setState({ peopleLoaded: true, activeWorkspaceId: "ws", confirmPersonSuggestion: confirm } as never);
    render(<PersonPage page={page("suggested")} />, { wrapper: TooltipProvider });
    expect(screen.getByText(/Confirm to add them to your people/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirm).toHaveBeenCalledWith("p1");
  });

  it("shows nothing for a confirmed person", () => {
    useCairnStore.setState({ peopleLoaded: true, activeWorkspaceId: "ws" } as never);
    render(<PersonPage page={page("confirmed")} />, { wrapper: TooltipProvider });
    expect(screen.queryByText(/Confirm to add them/)).toBeNull();
  });
});
