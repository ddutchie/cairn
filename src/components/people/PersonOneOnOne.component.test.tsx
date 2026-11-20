/**
 * The 1:1 loop on the person page: Slack fields (cache first, refresh behind, "as of" when old,
 * absent with no connector) and Next meeting with the Prep button and the saved brief.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCairnStore } from "@/store";
import type { PersonProfile, PrepBrief } from "../../../shared/people/oneonone";
import type { Person } from "../../../shared/types/people";
import type { PersonTimelineItem } from "../../../shared/types/people-view";

const client = vi.hoisted(() => ({
  profile: vi.fn(), refreshProfile: vi.fn(), prep: vi.fn(), runPrep: vi.fn(), onPrepUpdated: vi.fn(() => () => {}),
}));
vi.mock("@/lib/ipc/people", () => ({ peopleClient: client }));

import { NextMeeting, ProfileLine, localTimeIn, slackStatusText, usePersonProfile } from "./PersonOneOnOne";

const person = (extra: Partial<Person> = {}): Person => ({
  id: "p1", workspaceId: "ws1", name: "Ana Ruiz", aliases: [], emails: [], relationship: [], status: "confirmed", provenance: "explicit",
  isMe: false, agentPrivate: false, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});
const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
const meetingItem = (id: string, at: string, title = "Weekly 1:1"): PersonTimelineItem => ({
  kind: "meeting", at, notes: [], with: [],
  meeting: { id, workspaceId: "ws1", title, startsAt: at, source: "calendar", createdAt: at, updatedAt: at },
});
const brief = (extra: Partial<PrepBrief> = {}): PrepBrief => ({
  version: 1, status: "ready", personId: "p1", personName: "Ana Ruiz", date: "2026-11-18", generatedAt: new Date().toISOString(),
  summary: "Mostly on the billing migration.", recent: [{ text: "Raised a rollback plan", source: "Slack", url: "https://slack.test/1" }],
  followUps: ["Agree the rollout date"], questions: ["What blocks the rollout?"], sources: [], ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  client.onPrepUpdated.mockReturnValue(() => {});
  client.prep.mockResolvedValue({ brief: null, running: false });
  useCairnStore.setState({ activeWorkspaceId: "ws1" });
});

describe("ProfileLine", () => {
  it("shows title, local time and pronouns, and marks old values", () => {
    const profile: PersonProfile = { fields: { title: "Staff Engineer", timezone: "Europe/London", pronouns: "she/her" }, fetchedAt: "2026-11-01T00:00:00.000Z", stale: true, error: "offline" };
    render(<ProfileLine profile={profile} />);
    const line = screen.getByLabelText("From Slack");
    expect(line.textContent).toContain("Staff Engineer");
    expect(line.textContent).toContain("she/her");
    expect(line.textContent).toMatch(/\d{2}:\d{2} local/);
    expect(line.textContent).toContain("as of");
  });
  it("shows no marker for fresh values, and nothing at all when Slack gave no fields", () => {
    const { rerender, container } = render(<ProfileLine profile={{ fields: { title: "PM" }, fetchedAt: new Date().toISOString(), stale: false }} />);
    expect(container.textContent).not.toContain("as of");
    rerender(<ProfileLine profile={{ fields: {}, stale: false }} />);
    expect(container.textContent).toBe("");
    rerender(<ProfileLine profile={null} />);
    expect(container.textContent).toBe("");
  });
  it("says so when a Slack read failed and nothing is cached", () => {
    render(<ProfileLine profile={{ fields: {}, stale: false, error: "Slack's reply had no profile fields." }} />);
    expect(screen.getByRole("status").textContent).toBe("Slack profile unavailable: Slack's reply had no profile fields.");
  });
  it("shows a status emoji as a character, never the raw code", () => {
    const { container, rerender } = render(<ProfileLine profile={{ fields: { statusEmoji: ":headphones:", statusText: "Focus time" }, fetchedAt: new Date().toISOString(), stale: false }} />);
    expect(container.textContent).toContain("🎧 Focus time");
    rerender(<ProfileLine profile={{ fields: { statusEmoji: ":a_custom_one:", statusText: "Away" }, fetchedAt: new Date().toISOString(), stale: false }} />);
    expect(container.textContent).not.toContain(":a_custom_one:");
  });
  it("describes the Slack read for the Settings field", () => {
    expect(slackStatusText(null, null)).toMatch(/Add their Slack id/);
    expect(slackStatusText(null, "U1")).toMatch(/Reading/);
    expect(slackStatusText({ fields: {}, stale: false, error: "boom" }, "U1")).toBe("Couldn't read their Slack profile: boom");
    expect(slackStatusText({ fields: { title: "PM" }, fetchedAt: new Date().toISOString(), stale: false }, "U1")).toMatch(/^Read from Slack/);
    expect(slackStatusText({ fields: {}, stale: false }, "U1")).toMatch(/Not read from Slack yet/);
  });
  it("reads a zone it doesn't know as no local time", () => {
    expect(localTimeIn("Mars/Olympus")).toBeNull();
    expect(localTimeIn(undefined)).toBeNull();
  });
});

describe("usePersonProfile", () => {
  it("renders the cache first, then the refreshed value", async () => {
    client.profile.mockResolvedValue({ fields: { title: "Old title" }, fetchedAt: "2026-11-01T00:00:00.000Z", stale: true });
    let resolveRefresh!: (p: PersonProfile) => void;
    client.refreshProfile.mockReturnValue(new Promise<PersonProfile>((r) => { resolveRefresh = r; }));
    const { result } = renderHook(() => usePersonProfile({ id: "p1", slackId: "U1" }));
    await waitFor(() => expect(result.current?.fields.title).toBe("Old title"));
    await act(async () => { resolveRefresh({ fields: { title: "New title" }, fetchedAt: new Date().toISOString(), stale: false }); });
    await waitFor(() => expect(result.current?.fields.title).toBe("New title"));
  });
  it("doesn't call out for someone with no Slack id", async () => {
    client.profile.mockResolvedValue({ fields: {}, stale: false });
    const { result } = renderHook(() => usePersonProfile({ id: "p1" }));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(client.refreshProfile).not.toHaveBeenCalled();
  });
  it("ignores a late answer for the person it has moved off", async () => {
    let late!: (p: PersonProfile) => void;
    client.profile.mockImplementation((id: string) => (id === "p1" ? new Promise<PersonProfile>((r) => { late = r; }) : Promise.resolve({ fields: { title: "Bob's" }, stale: false })));
    const { result, rerender } = renderHook(({ id }) => usePersonProfile({ id }), { initialProps: { id: "p1" } });
    rerender({ id: "p2" });
    await waitFor(() => expect(result.current?.fields.title).toBe("Bob's"));
    await act(async () => { late({ fields: { title: "Ana's" }, stale: false }); });
    expect(result.current?.fields.title).toBe("Bob's");
  });
});

describe("NextMeeting", () => {
  const renderIt = (timeline: PersonTimelineItem[] = [meetingItem("m-next", future)]) =>
    render(<NextMeeting person={person()} timeline={timeline} />, { wrapper: TooltipProvider });

  it("prepares for the soonest meeting that hasn't begun", async () => {
    client.runPrep.mockResolvedValue({ runId: "r1" });
    renderIt([meetingItem("past", "2020-01-01T00:00:00.000Z"), meetingItem("later", new Date(Date.now() + 9 * 86_400_000).toISOString()), meetingItem("m-next", future)]);
    fireEvent.click(await screen.findByRole("button", { name: /Prepare/ }));
    await waitFor(() => expect(client.runPrep).toHaveBeenCalledWith("ws1", "p1", "m-next"));
    expect(await screen.findByRole("button", { name: /Preparing/ })).toBeDisabled();
  });

  it("can prepare with no meeting booked", async () => {
    client.runPrep.mockResolvedValue({ runId: "r1" });
    renderIt([]);
    expect(await screen.findByText("None booked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Prepare/ }));
    await waitFor(() => expect(client.runPrep).toHaveBeenCalledWith("ws1", "p1", undefined));
  });

  it("says why nothing started", async () => {
    client.runPrep.mockResolvedValue({ skipped: "no-ai" });
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: /Prepare/ }));
    expect((await screen.findByRole("status")).textContent).toContain("AI connection");
  });

  it("shows the saved brief about their work, with the app and link", async () => {
    client.prep.mockResolvedValue({ brief: brief(), running: false });
    renderIt();
    expect(await screen.findByText("Mostly on the billing migration.")).toBeTruthy();
    expect(screen.getByText("Raised a rollback plan")).toBeTruthy();
    expect(screen.getByText("Agree the rollout date")).toBeTruthy();
    expect(screen.getByText("What blocks the rollout?")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Slack/ }).getAttribute("href")).toBe("https://slack.test/1");
    expect(screen.getByRole("button", { name: /Prepare again/ })).toBeTruthy();
  });

  it("doesn't turn a non-http link into an anchor", async () => {
    client.prep.mockResolvedValue({ brief: brief({ recent: [{ text: "Odd", source: "X", url: "javascript:alert(1)" }] }), running: false });
    renderIt();
    await screen.findByText("Odd");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a failed run's reason", async () => {
    client.prep.mockResolvedValue({ brief: brief({ summary: "", recent: [], followUps: [], questions: [], error: "provider down" }), running: false });
    renderIt();
    expect((await screen.findByText(/provider down/)).textContent).toContain("Couldn't prepare");
  });

  it("reloads when a run saves", async () => {
    let fire!: (e: { workspaceId: string; personId: string; status: "ready" }) => void;
    client.onPrepUpdated.mockImplementation(((cb: typeof fire) => { fire = cb; return () => {}; }) as never);
    renderIt();
    await waitFor(() => expect(client.prep).toHaveBeenCalledTimes(1));
    client.prep.mockResolvedValue({ brief: brief(), running: false });
    await act(async () => { fire({ workspaceId: "ws1", personId: "other", status: "ready" }); });
    expect(client.prep).toHaveBeenCalledTimes(1);
    await act(async () => { fire({ workspaceId: "ws1", personId: "p1", status: "ready" }); });
    expect(await screen.findByText("Mostly on the billing migration.")).toBeTruthy();
  });
});
