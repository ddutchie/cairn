/**
 * People view: the list grouped by relationship (someone with two relationship
 * types appears under both), the lock for people private from agents, the
 * suggestions tray, and search. Outside Electron the store's loads are no-ops,
 * so the list comes straight from the state set here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  agentPrivate: false, teams: [],
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

  it("keeps a person opened from elsewhere (also under Strict Mode), and starts at the list on the next visit", () => {
    // openPerson (Today nudge, tool card) selects before the view mounts.
    useCairnStore.setState({ activeView: "people", selectedPersonId: "p1" });
    render(<React.StrictMode><PeopleView /></React.StrictMode>, { wrapper: TooltipProvider });
    expect(useCairnStore.getState().selectedPersonId).toBe("p1");
    act(() => useCairnStore.getState().setView("overview"));
    expect(useCairnStore.getState().selectedPersonId).toBeNull();
  });

  it("switches to the team and time zone pictures, and hides the list controls there", () => {
    useCairnStore.setState({
      people: [
        person("me", "Me", [], { isMe: true, timezone: "Europe/London" }),
        person("p1", "Ada Report", ["direct_report"], { team: "Platform", timezone: "America/New_York" }),
        person("p2", "Elisa Boss", ["manager"], { team: "Platform" }),
      ],
    });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Teams" }));
    const card = screen.getByRole("button", { name: /^Platform/ });
    expect(within(card).getByRole("img", { name: "Ada Report, Elisa Boss" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search people" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Time zones" }));
    expect(within(screen.getByRole("table", { name: "Working hours by person" })).getByText("Ada Report")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "No time zone set" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("textbox", { name: "Search people" })).toBeInTheDocument();
  });

  it("opens a team, then a person from it, in the side panel, and can hand them to the list", () => {
    useCairnStore.setState({ people: [person("p1", "Ada Report", ["direct_report"], { team: "Platform", title: "Engineer" })], teams: [] });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Teams" }));
    fireEvent.click(screen.getByRole("button", { name: /^Platform/ }));
    const team = screen.getByRole("complementary", { name: "Team" });
    expect(within(team).getByRole("heading", { name: "Platform" })).toBeInTheDocument();
    expect(within(team).getByRole("button", { name: "Add details" })).toBeInTheDocument();
    fireEvent.click(within(team).getByRole("button", { name: /Ada Report/ }));
    expect(screen.getByRole("complementary", { name: "Person" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open in list/ }));
    expect(useCairnStore.getState().selectedPersonId).toBe("p1");
    expect(screen.getByRole("complementary", { name: "People" })).toBeInTheDocument();
  });

  it("shows who is due to be met, against the cadence, with status in words", () => {
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    useCairnStore.setState({
      people: [
        person("me", "Me", [], { isMe: true }),
        person("p1", "Late Larry", ["peer"], { cadence: "weekly", lastMetAt: ago(10) }),
        person("p2", "Fine Fran", ["peer"], { cadence: "monthly", lastMetAt: ago(2) }),
        person("p3", "Unset Uma", ["peer"]),
      ],
    });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Rhythm" }));
    expect(screen.getByText("Overdue by 3 days")).toBeInTheDocument();
    expect(screen.getByText("28 days to go")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "No cadence set" })).getByText("Unset Uma")).toBeInTheDocument();
  });

  it("lists people with no link to you under Bridges", () => {
    useCairnStore.setState({
      people: [
        person("me", "Me", [], { isMe: true }),
        person("p1", "Linked Lin", ["peer"]),
        person("p2", "Lonely Lou", []),
      ],
    });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Bridges" }));
    expect(within(screen.getByRole("region", { name: "Not connected to you" })).getByText("Lonely Lou")).toBeInTheDocument();
    expect(screen.getByText("Nobody is your only route to anyone else.")).toBeInTheDocument();
  });

  it("places people on the map from their time zone and lists the rest", () => {
    useCairnStore.setState({
      people: [
        person("me", "Me", [], { isMe: true, timezone: "Europe/London" }),
        person("p1", "Ada Report", ["direct_report"], { timezone: "Europe/London" }),
        person("p2", "No Zone", []),
      ],
    });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    const marker = screen.getByRole("button", { name: /^London, 2 people, / });
    fireEvent.click(marker);
    const who = screen.getByRole("region", { name: "Who is there" });
    expect(within(who).getByText("Ada Report")).toBeInTheDocument();
    expect(within(who).getByText("Me (you)")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Not on the map" })).getByText("No Zone")).toBeInTheDocument();
  });

  it("pins people at their own city when it lies in their zone, and ignores a location that disagrees", () => {
    useCairnStore.setState({
      people: [
        person("p1", "Mia", [], { timezone: "America/Toronto", location: "Montreal, QC" }),
        person("p2", "Tom", [], { timezone: "America/Toronto", location: "Toronto" }),
        person("p3", "Stale", [], { timezone: "America/Los_Angeles", location: "Berlin" }),
        // Same UTC offset as Berlin in winter, but a different zone: Berlin's pin must not be used.
        person("p4", "Ada", [], { timezone: "Africa/Lagos", location: "Berlin" }),
      ],
    });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByRole("button", { name: /^Montreal, 1 person, / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Toronto, 1 person, / })).toBeInTheDocument();
    // Berlin isn't in Los Angeles's zone, so the zone's own city is used.
    expect(screen.getByRole("button", { name: /^Los Angeles, 1 person, / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Lagos, 1 person, / })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Berlin, / })).toBeNull();
  });

  it("opens the add form from any picture by switching to the list", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Teams" }));
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    expect(screen.getByRole("form", { name: "Add a person" })).toBeInTheDocument();
  });

  it("doesn't leave Org chart blank when the people bridge is absent", () => {
    useCairnStore.setState({ peopleLoaded: false, people: [] });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Org chart" }));
    expect(screen.getByText(/No people yet/)).toBeInTheDocument();
  });

  it("groups the list by team or place, and remembers the choice", async () => {
    const user = userEvent.setup();
    useCairnStore.setState({
      people: [
        person("p1", "Ada Report", ["direct_report"], { team: "Platform", timezone: "Europe/Berlin" }),
        person("p2", "Elisa Boss", ["manager"], { team: "platform" }),
        person("p3", "Zed", ["peer"]),
      ],
    });
    renderView();
    const list = screen.getByRole("complementary", { name: "People" });
    await user.click(within(list).getByRole("button", { name: /^Group by:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "By team" }));
    expect(within(list).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Platform", "No team"]);
    expect(localStorage.getItem("people.listGrouping")).toBe("team");
    await user.click(within(list).getByRole("button", { name: /^Group by:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "By location" }));
    expect(within(list).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Berlin", "Unknown"]);
    localStorage.removeItem("people.listGrouping");
  });

  it("keeps the minutes in a time zone row's working hours", () => {
    useCairnStore.setState({
      people: [
        person("me", "Me", [], { isMe: true, timezone: "UTC" }),
        person("p1", "Ravi", ["peer"], { timezone: "Asia/Kolkata" }),
      ],
    });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Time zones" }));
    expect(screen.getByLabelText(/Ravi: works 3:30 to 11:30 your time/)).toBeInTheDocument();
  });
});
