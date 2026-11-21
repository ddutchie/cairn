/**
 * Saving a location fills an empty time zone, but never replaces one that is
 * set, including one saved a moment ago that the people list doesn't show yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PersonPage } from "./PersonPage";
import { clearProfileWrites } from "./recent-profile-writes";
import type { PersonPage as PersonPageModel } from "../../../shared/types/people-view";

const person = {
  id: "p1", workspaceId: "ws", name: "Ada", aliases: [], emails: [], relationship: [], status: "confirmed",
  provenance: "explicit", isMe: false, agentPrivate: false, teams: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
};
const model = { person, relations: [], timeline: [], persona: null } as unknown as PersonPageModel;
const updatePerson = vi.fn(async () => {});

beforeEach(() => {
  clearProfileWrites();
  updatePerson.mockClear();
  useCairnStore.setState({ people: [person] as never, peopleLoaded: true, activeWorkspaceId: "ws", updatePerson } as never);
});

function edit() {
  render(<PersonPage page={model} />, { wrapper: TooltipProvider });
  fireEvent.click(screen.getByRole("button", { name: /Edit details/ }));
}
const save = (label: string, text: string) => {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Escape" }); // close the suggestions so Enter saves the typed text
  fireEvent.blur(input);
};

describe("person profile: location and time zone", () => {
  it("fills an empty time zone from a typed location", () => {
    edit();
    save("Location", "Montreal");
    expect(updatePerson).toHaveBeenCalledWith("p1", { location: "Montreal", timezone: "America/Toronto" });
  });

  it("does not replace a time zone saved a moment ago, before the list shows it", () => {
    edit();
    save("Time zone", "Europe/London");
    expect(updatePerson).toHaveBeenLastCalledWith("p1", { timezone: "Europe/London" });
    // The list (and this page) still say the time zone is empty.
    save("Location", "San Francisco");
    expect(updatePerson).toHaveBeenLastCalledWith("p1", { location: "San Francisco" });
  });
});
