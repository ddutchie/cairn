/**
 * People view: the list grouped by relationship (someone with two relationship
 * types appears under both), the lock for people private from agents, the
 * suggestions tray, and search. Outside Electron the store's loads are no-ops,
 * so the list comes straight from the state set here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PersonSummary } from "../../../shared/types/people-view";
import type { RelationshipType } from "../../../shared/types/people";
import { PeopleView } from "./PeopleView";

const person = (id: string, name: string, types: RelationshipType[], extra: Partial<PersonSummary> = {}): PersonSummary => ({
  id,
  workspaceId: "ws1",
  name,
  aliases: [],
  emails: [],
  relationship: types.map((type) => ({ type, provenance: "explicit" as const })),
  status: "confirmed",
  provenance: "explicit",
  isMe: false,
  agentPrivate: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});

function renderView() {
  return render(<PeopleView />, { wrapper: TooltipProvider });
}

beforeEach(() => {
  useCairnStore.setState({
    activeWorkspaceId: "ws1",
    peopleLoaded: true,
    peopleSuggestions: [],
    selectedPersonId: null,
    personPage: null,
    people: [
      person("p1", "Ada Report", ["direct_report"]),
      person("p2", "Elisa Boss", ["manager"]),
      person("p3", "Sébastien Morel", ["stakeholder", "mentor"], { aliases: ["Seb"] }),
      person("p4", "Pat Peer", ["peer"], { agentPrivate: true }),
      person("p5", "Cam Candidate", ["candidate"]),
      person("p6", "Bo Buddy", ["buddy"]),
      person("p7", "No Label", []),
    ],
  });
});

describe("PeopleView", () => {
  it("groups people by relationship in a fixed order", () => {
    renderView();
    const list = screen.getByRole("complementary", { name: "People" });
    const headings = within(list).getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(headings).toEqual(["Direct reports", "Manager", "Peers", "Stakeholders", "Mentors", "Candidates", "Other"]);
    const other = within(list).getByRole("region", { name: "Other" });
    expect(within(other).getByText("Bo Buddy")).toBeInTheDocument();
    expect(within(other).getByText("No Label")).toBeInTheDocument();
  });

  it("lists someone under each of their relationship types", () => {
    renderView();
    expect(within(screen.getByRole("region", { name: "Stakeholders" })).getByText("Sébastien Morel")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Mentors" })).getByText("Sébastien Morel")).toBeInTheDocument();
  });

  it("shows a lock for people private from agents", () => {
    renderView();
    const peers = screen.getByRole("region", { name: "Peers" });
    expect(within(peers).getByLabelText("Private from agents")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Manager" })).queryByLabelText("Private from agents")).toBeNull();
  });

  it("searches names and aliases, ignoring accents", () => {
    renderView();
    fireEvent.change(screen.getByRole("textbox", { name: "Search people" }), { target: { value: "sebastien" } });
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["Stakeholders", "Mentors"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Search people" }), { target: { value: "seb" } });
    expect(screen.getAllByText("Sébastien Morel")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Search people" }), { target: { value: "zzz" } });
    expect(screen.getByText("Nobody matches.")).toBeInTheDocument();
  });

  it("shows the suggestions tray only when there are suggestions", () => {
    const { unmount } = renderView();
    expect(screen.queryByRole("region", { name: "Suggested people" })).toBeNull();
    unmount();
    useCairnStore.setState({ peopleSuggestions: [person("s1", "Maybe Someone", [], { status: "suggested" })] });
    renderView();
    const tray = screen.getByRole("region", { name: "Suggested people" });
    expect(within(tray).getByRole("button", { name: "Confirm Maybe Someone" })).toBeInTheDocument();
    expect(within(tray).getByRole("button", { name: "Dismiss Maybe Someone" })).toBeInTheDocument();
  });

  it("offers to add the first person when the list is empty", () => {
    useCairnStore.setState({ people: [] });
    renderView();
    expect(screen.getByText("No people yet")).toBeInTheDocument();
  });

  it("keeps a person opened from elsewhere, and starts at the list on the next visit", () => {
    // openPerson (Today nudge, tool card) selects before the view mounts.
    useCairnStore.setState({ selectedPersonId: "p1" });
    const { unmount } = renderView();
    expect(useCairnStore.getState().selectedPersonId).toBe("p1");
    unmount();
    expect(useCairnStore.getState().selectedPersonId).toBeNull();
  });
});
