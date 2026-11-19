/**
 * Insights People canvases (W7): the org chart and relationship canvas read
 * the people slice (outside Electron the network fetch is a no-op, so links
 * come from the relationship chips on "me"), open a person on click, and the
 * Insights tabs list them only while the flag is on.
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

const person = (id: string, name: string, types: RelationshipType[], extra: Partial<PersonSummary> = {}): PersonSummary => ({
  id, workspaceId: "ws1", name, aliases: [], emails: [],
  relationship: types.map((type) => ({ type, provenance: "explicit" as const })),
  status: "confirmed", provenance: "explicit", isMe: false, agentPrivate: false,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});

const seed = (people: PersonSummary[], peopleEnabled = true) =>
  useCairnStore.setState({ activeWorkspaceId: "ws1", peopleEnabled, peopleLoaded: true, people, selectedPersonId: null, activeView: "insights" });

beforeEach(() => seed([]));

describe("OrgChartCanvas", () => {
  it("says so when nobody people exist, and when no reporting lines do", () => {
    const first = render(<OrgChartCanvas />);
    expect(screen.getByText(/No people yet/)).toBeInTheDocument();
    first.unmount();
    seed([person("a", "Ann", ["peer"])]);
    render(<OrgChartCanvas />);
    expect(screen.getByText(/No reporting lines yet/)).toBeInTheDocument();
  });

  it("draws me with their manager and reports, lists the rest, and opens a person on click", () => {
    seed([
      person("me", "Me Myself", [], { isMe: true }),
      person("boss", "Big Boss", ["manager"]),
      person("rep", "Dana Report", ["direct_report"]),
      person("pal", "Pat Peer", ["peer"]),
    ]);
    render(<OrgChartCanvas />);
    expect(screen.getByRole("button", { name: /^Big Boss, Manager, 1 direct report/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Me Myself \(you\)/ })).toBeInTheDocument();
    expect(screen.getByText("Not in a reporting line (1)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Dana Report/ }));
    expect(useCairnStore.getState().selectedPersonId).toBe("rep");
    expect(useCairnStore.getState().activeView).toBe("people");
  });

  it("opens a person from the keyboard", () => {
    seed([person("me", "Me Myself", [], { isMe: true }), person("rep", "Dana Report", ["direct_report"])]);
    render(<OrgChartCanvas />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Dana Report/ }), { key: "Enter" });
    expect(useCairnStore.getState().selectedPersonId).toBe("rep");
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
    render(<RelationshipCanvas />);
    expect(screen.getByRole("button", { name: /Reporting line, 1/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 without a link here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Dana Report/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Lone Wolf/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Reporting line, 1/ }));
    expect(screen.queryByRole("button", { name: /^Dana Report/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Pat Peer/ })).toBeInTheDocument();
  });

  it("explains when there are no relationships", () => {
    seed([person("a", "Ann", [])]);
    render(<RelationshipCanvas />);
    expect(screen.getByText(/No relationships yet/)).toBeInTheDocument();
  });
});

describe("InsightsView gating", () => {
  it("has the People canvases only while the flag is on", () => {
    seed([], false);
    const { unmount } = render(<InsightsView />, { wrapper: TooltipProvider });
    expect(screen.queryByRole("tab", { name: /Org chart/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /Relationships/ })).toBeNull();
    unmount();
    seed([], true);
    render(<InsightsView />, { wrapper: TooltipProvider });
    expect(screen.getByRole("tab", { name: /Org chart/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Relationships/ })).toBeInTheDocument();
  });
});
