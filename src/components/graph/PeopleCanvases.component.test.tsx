/**
 * Insights People canvases (W7): the org chart and relationship canvas read
 * the people slice (outside Electron the network fetch is a no-op, so links
 * come from the relationship chips on "me"), open a person on click, and the
 * Insights lists them as tabs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCairnStore } from "@/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PersonSummary } from "../../../shared/types/people-view";
import type { RelationshipType } from "../../../shared/types/people";
import { OrgChartCanvas } from "./OrgChartCanvas";
import { RelationshipCanvas } from "./RelationshipCanvas";
import { InsightsView } from "./InsightsView";
import { ConnectionsGraph } from "@/components/people/ConnectionsGraph";

const person = (id: string, name: string, types: RelationshipType[], extra: Partial<PersonSummary> = {}): PersonSummary => ({
  id, workspaceId: "ws1", name, aliases: [], emails: [],
  relationship: types.map((type) => ({ type, provenance: "explicit" as const })),
  status: "confirmed", provenance: "explicit", isMe: false, agentPrivate: false, teams: [],
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});

const seed = (people: PersonSummary[]) =>
  useCairnStore.setState({ activeWorkspaceId: "ws1", peopleLoaded: true, people, selectedPersonId: null, peoplePanelId: null, activeView: "insights" });

beforeEach(() => seed([]));

describe("OrgChartCanvas", () => {
  it("says so when nobody people exist, and when no reporting lines do", () => {
    const first = render(<OrgChartCanvas />, { wrapper: TooltipProvider });
    expect(screen.getByText(/No people yet/)).toBeInTheDocument();
    first.unmount();
    seed([person("a", "Ann", ["peer"])]);
    render(<OrgChartCanvas />, { wrapper: TooltipProvider });
    expect(screen.getByText(/No reporting lines yet/)).toBeInTheDocument();
    expect(screen.getByText("Not in a reporting line (1)")).toBeInTheDocument();
  });

  it("draws me with their manager and reports, lists the rest, and opens a person on click", () => {
    seed([
      person("me", "Me Myself", [], { isMe: true }),
      person("boss", "Big Boss", ["manager"]),
      person("rep", "Dana Report", ["direct_report"]),
      person("pal", "Pat Peer", ["peer"]),
    ]);
    render(<OrgChartCanvas />, { wrapper: TooltipProvider });
    expect(screen.getByRole("button", { name: /^Big Boss, Manager, 1 direct report/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Me Myself \(you\)/ })).toBeInTheDocument();
    expect(screen.getByText("Not in a reporting line (1)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Dana Report/ }));
    expect(useCairnStore.getState().peoplePanelId).toBe("rep");
    expect(useCairnStore.getState().activeView).toBe("insights");
  });

  it("cards are native buttons, so the keyboard reaches them", () => {
    seed([person("me", "Me Myself", [], { isMe: true }), person("rep", "Dana Report", ["direct_report"])]);
    render(<OrgChartCanvas />, { wrapper: TooltipProvider });
    const card = screen.getByRole("button", { name: /^Dana Report/ });
    expect(card.tagName).toBe("BUTTON");
    card.focus();
    expect(document.activeElement).toBe(card);
  });

  it("shows the team tree, with each team's lead and size", () => {
    seed([
      person("me", "Me Myself", [], { isMe: true, team: "Sync" }),
      person("rep", "Dana Report", ["direct_report"], { team: "Sync" }),
    ]);
    const t = (id: string, name: string, extra = {}) => ({ id, workspaceId: "ws1", name, kind: "team" as const, links: [], createdAt: "", updatedAt: "", ...extra });
    useCairnStore.setState({ teams: [t("pl", "Platform"), t("sy", "Sync", { parentTeamId: "pl", leadPersonId: "rep" })] });
    const opened: string[] = [];
    render(<OrgChartCanvas onOpenTeam={(n) => opened.push(n)} />, { wrapper: TooltipProvider });
    fireEvent.click(screen.getByRole("button", { name: "Teams" }));
    expect(screen.getByRole("button", { name: "Platform, 2 people. Open team" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync, Lead Dana Report · 2 people. Open team" }));
    expect(opened).toEqual(["sy"]);
    useCairnStore.setState({ teams: [] });
  });
});

describe("RelationshipCanvas", () => {
  it("shows kind filters with counts, drawing only people with a link, and toggles them", () => {
    seed([
      person("me", "Me Myself", [], { isMe: true }),
      person("rep", "Dana Report", ["direct_report"]),
      person("pal", "Pat Peer", ["peer"]),
      person("lone", "Lone Wolf", []),
    ]);
    render(<RelationshipCanvas />, { wrapper: TooltipProvider });
    expect(screen.getByRole("button", { name: /Reporting line, 1/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 without a link here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Dana Report/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Lone Wolf/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Reporting line, 1/ }));
    expect(screen.queryByRole("button", { name: /^Dana Report/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Pat Peer/ })).toBeInTheDocument();
  });

  it("tells the canvas which person a keyboard user is on", () => {
    seed([person("me", "Me Myself", [], { isMe: true }), person("rep", "Dana Report", ["direct_report"])]);
    const { container } = render(<RelationshipCanvas />, { wrapper: TooltipProvider });
    const button = screen.getByRole("button", { name: /^Dana Report/ });
    fireEvent.focus(button);
    // The canvas redraws with the person highlighted; nothing throws in a canvas-less test DOM.
    expect(container.querySelector("canvas")).not.toBeNull();
    fireEvent.blur(button);
  });

  it("explains when there are no relationships", () => {
    seed([person("a", "Ann", [])]);
    render(<RelationshipCanvas />, { wrapper: TooltipProvider });
    expect(screen.getByText(/No relationships yet/)).toBeInTheDocument();
  });
});

describe("InsightsView tabs", () => {
  it("lists the People canvases", () => {
    seed([]);
    render(<InsightsView />, { wrapper: TooltipProvider });
    expect(screen.getByRole("tab", { name: /Org chart/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Relationships/ })).toBeInTheDocument();
  });
});

describe("ConnectionsGraph", () => {
  const withTree = () => seed([
    person("me", "Me Myself", [], { isMe: true }),
    person("rep", "Dana Report", ["direct_report"]),
    person("pal", "Pat Peer", ["peer"]),
    person("lone", "Lone Wolf", []),
  ]);

  it("lists the people linked to a person and opens one on click", () => {
    withTree();
    render(<ConnectionsGraph personId="me" compact />, { wrapper: TooltipProvider });
    expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByText("2 people")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Lone Wolf/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Dana Report/ }));
    expect(useCairnStore.getState().peoplePanelId).toBe("rep");
  });

  it("has no zoom controls and renders nothing for a person without links", () => {
    withTree();
    const first = render(<ConnectionsGraph personId="me" compact />, { wrapper: TooltipProvider });
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    first.unmount();
    const second = render(<ConnectionsGraph personId="lone" compact />, { wrapper: TooltipProvider });
    expect(second.container).toBeEmptyDOMElement();
  });
});
