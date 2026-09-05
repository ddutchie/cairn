import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { ConversationSessionStatus } from "./ConversationSessionStatus";
import { useCairnStore } from "@/store";
import { makeSessionProjection, type GoalSummary, type SessionProjection } from "../../../shared/agent/session-projection";

/**
 * Chat-pane parity for the jobs dock + goal chip.
 *
 * Pins the ConversationSessionStatus wiring: hidden when the session has no
 * goal and no jobs, visible goal chip from the initial `session:goal`
 * snapshot, live goal updates via `session:projection kind:"goal"` (scoped to
 * this session only), and the jobs dock filling from kind:`"jobs"` with the
 * coding-pane owner filter (owned + unowned, never foreign).
 */

type ProjectionCb = (projection: SessionProjection) => void;

let projectionCbs: ProjectionCb[];
let goalMock: Mock;

function mockSession(goal: GoalSummary | null) {
  projectionCbs = [];
  goalMock = vi.fn(async (_sessionId: string) => ({ ok: true as const, value: goal }));
  const api = {
    goal: goalMock,
    onProjection: vi.fn((cb: ProjectionCb) => {
      projectionCbs.push(cb);
      return () => {
        projectionCbs = projectionCbs.filter((c) => c !== cb);
      };
    }),
    killJob: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  (window as unknown as { electron: { session: typeof api } }).electron = { session: api };
}

function emit(projection: SessionProjection) {
  act(() => {
    for (const cb of [...projectionCbs]) cb(projection);
  });
}

function goal(over: Partial<GoalSummary> = {}): GoalSummary {
  return {
    id: "goal-1",
    revision: 1,
    objective: "Ship the widget",
    phase: "active",
    roundsStarted: 0,
    maxGoalRounds: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

const SESSION = "chat-thread-1";
const now = 1700000000000;

beforeEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  useCairnStore.setState({ sessionJobs: {} });
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  useCairnStore.setState({ sessionJobs: {} });
});

describe("ConversationSessionStatus", () => {
  it("renders nothing when there is no goal and no jobs", () => {
    mockSession(null);
    const { container } = render(<ConversationSessionStatus sessionId={SESSION} />);
    expect(container.textContent).toBe("");
  });

  it("shows the goal chip from the initial session:goal snapshot", async () => {
    mockSession(goal());
    render(<ConversationSessionStatus sessionId={SESSION} />);
    expect(await screen.findByText("Ship the widget")).toBeTruthy();
    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(goalMock).toHaveBeenCalledWith(SESSION);
  });

  it("shows the goal chip from a live goal projection", async () => {
    mockSession(null);
    render(<ConversationSessionStatus sessionId={SESSION} />);
    expect(screen.queryByText("Ship the widget")).toBeNull();
    emit(makeSessionProjection(SESSION, "goal", { goal: goal() }));
    expect(await screen.findByText("Ship the widget")).toBeTruthy();
  });

  it("ignores goal projections for other sessions", async () => {
    mockSession(null);
    render(<ConversationSessionStatus sessionId={SESSION} />);
    emit(makeSessionProjection("chat-other", "goal", { goal: goal() }));
    await waitFor(() => expect(projectionCbs.length).toBeGreaterThan(0));
    // Let any stray state update flush; the chip must stay hidden.
    await act(async () => {});
    expect(screen.queryByText("Ship the widget")).toBeNull();
  });

  it("hides the chip when the goal clears (null projection)", async () => {
    mockSession(goal());
    render(<ConversationSessionStatus sessionId={SESSION} />);
    expect(await screen.findByText("Ship the widget")).toBeTruthy();
    emit(makeSessionProjection(SESSION, "goal", { goal: null }));
    await waitFor(() => expect(screen.queryByText("Ship the widget")).toBeNull());
  });

  it("fills the jobs dock from a jobs projection (owned + unowned, never foreign)", async () => {
    mockSession(null);
    render(<ConversationSessionStatus sessionId={SESSION} />);
    emit(makeSessionProjection(SESSION, "jobs", {
      ownerSession: SESSION,
      jobs: [
        { id: "j1", kind: "bash", label: "owned job", status: "running", startedAt: now, ownerSession: SESSION },
        { id: "j2", kind: "bash", label: "unowned job", status: "running", startedAt: now },
        { id: "j3", kind: "bash", label: "foreign job", status: "running", startedAt: now, ownerSession: "chat-other" },
      ],
    }));
    expect(await screen.findByText(/owned job/)).toBeTruthy();
    // The dock starts collapsed (summary only) — expand to see the rows.
    fireEvent.click(screen.getByTitle("Expand jobs"));
    expect(screen.getByText(/unowned job/)).toBeTruthy();
    expect(screen.queryByText(/foreign job/)).toBeNull();
  });

  it("ignores jobs projections for other sessions", async () => {
    mockSession(null);
    render(<ConversationSessionStatus sessionId={SESSION} />);
    emit(makeSessionProjection("chat-other", "jobs", {
      jobs: [{ id: "j9", kind: "bash", label: "other session job", status: "running", startedAt: now }],
    }));
    await waitFor(() => expect(projectionCbs.length).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByText(/other session job/)).toBeNull();
  });
});
