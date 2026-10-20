import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
import type { BoardColumn, TaskCard } from "@/types";

/**
 * Renderer tests for the shared task-card right-click menu: the done/reopen
 * target column, the radio submenus, due-date shortcuts, and the destructive
 * actions. The store is faked so each action is observable.
 */

const col = (id: string, type: string, order: number): BoardColumn =>
  ({ id, projectId: "p1", workspaceId: "ws", name: id, type, order, createdAt: "", updatedAt: "" } as unknown as BoardColumn);

const makeCard = (extra: Partial<TaskCard> = {}): TaskCard =>
  ({
    id: "card-1", columnId: "todo", projectId: "p1", workspaceId: "ws", title: "Write tests",
    tagIds: [], priority: "medium", linkedNoteIds: [], blockedByIds: [], order: 0,
    createdAt: "", updatedAt: "", ...extra,
  } as unknown as TaskCard);

const actions = {
  updateCard: vi.fn(),
  moveCard: vi.fn(),
  archiveCard: vi.fn(),
  deleteCard: vi.fn(),
  duplicateCard: vi.fn(),
  moveCardToProject: vi.fn(),
};

let state: Record<string, unknown>;

vi.mock("@/store", () => ({
  useCairnStore: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
}));

import { CardContextMenu } from "./card-context-menu";

function setState(overrides: Record<string, unknown> = {}) {
  state = {
    columns: [col("todo", "todo", 0), col("doing", "in_progress", 1), col("done", "done", 2)],
    projects: [
      { id: "p1", workspaceId: "ws", name: "Alpha" },
      { id: "p2", workspaceId: "ws", name: "Beta" },
    ],
    cards: [makeCard({ id: "d1", columnId: "done" }), makeCard({ id: "d2", columnId: "done" })],
    ...actions,
    ...overrides,
  };
}

function openMenu(card: TaskCard, onOpen?: (id: string) => void) {
  render(
    <CardContextMenu card={card} onOpen={onOpen}>
      <button type="button">chip</button>
    </CardContextMenu>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "chip" }));
}

/** Open a submenu with the keyboard (jsdom can't drive Radix's pointer grace area). */
async function openSub(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const trigger = await screen.findByRole("menuitem", { name });
  trigger.focus();
  await user.keyboard("{ArrowRight}");
}

describe("CardContextMenu", () => {
  beforeEach(() => {
    Object.values(actions).forEach((fn) => fn.mockReset());
    setState();
  });

  it("Mark done moves the card to the end of the first done column", async () => {
    openMenu(makeCard());
    await userEvent.click(await screen.findByRole("menuitem", { name: /mark done/i }));
    // Two non-archived cards already sit in "done" → index 2.
    expect(actions.moveCard).toHaveBeenCalledWith("card-1", "done", 2);
  });

  it("offers Reopen (to the todo column) instead of Mark done for a done card", async () => {
    openMenu(makeCard({ columnId: "done" }));
    expect(screen.queryByRole("menuitem", { name: /mark done/i })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("menuitem", { name: /reopen/i }));
    expect(actions.moveCard).toHaveBeenCalledWith("card-1", "todo", 0);
  });

  it("hides Mark done when the project has no done column", async () => {
    setState({ columns: [col("todo", "todo", 0), col("doing", "in_progress", 1)] });
    openMenu(makeCard());
    await screen.findByRole("menuitem", { name: /archive/i });
    expect(screen.queryByRole("menuitem", { name: /mark done/i })).not.toBeInTheDocument();
  });

  it("only lists Open card when a handler is provided", async () => {
    const onOpen = vi.fn();
    openMenu(makeCard(), onOpen);
    await userEvent.click(await screen.findByRole("menuitem", { name: /open card/i }));
    expect(onOpen).toHaveBeenCalledWith("card-1");
  });

  it("Archive, Duplicate and Delete call their store actions", async () => {
    const user = userEvent.setup();
    for (const [name, action] of [
      [/archive/i, actions.archiveCard],
      [/duplicate/i, actions.duplicateCard],
      [/delete/i, actions.deleteCard],
    ] as const) {
      const { unmount } = render(
        <CardContextMenu card={makeCard()}>
          <button type="button">chip</button>
        </CardContextMenu>,
      );
      fireEvent.contextMenu(screen.getByRole("button", { name: "chip" }));
      await user.click(await screen.findByRole("menuitem", { name }));
      expect(action).toHaveBeenCalledWith("card-1");
      unmount();
    }
  });

  it("sets a due date from the shortcuts and only offers Clear when one is set", async () => {
    const user = userEvent.setup();
    openMenu(makeCard());
    await openSub(user, /due date/i);
    expect(screen.queryByRole("menuitem", { name: /clear due date/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Today" }));
    expect(actions.updateCard).toHaveBeenCalledWith("card-1", { dueDate: format(new Date(), "yyyy-MM-dd") });
  });

  it("clears the due date", async () => {
    const user = userEvent.setup();
    openMenu(makeCard({ dueDate: "2026-10-30" }));
    await openSub(user, /due date/i);
    fireEvent.click(await screen.findByRole("menuitem", { name: /clear due date/i }));
    expect(actions.updateCard).toHaveBeenCalledWith("card-1", { dueDate: undefined });
  });

  it("changes priority through the radio submenu", async () => {
    const user = userEvent.setup();
    openMenu(makeCard());
    await openSub(user, /priority/i);
    expect(await screen.findByRole("menuitemradio", { name: /medium/i })).toBeChecked();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /urgent/i }));
    expect(actions.updateCard).toHaveBeenCalledWith("card-1", { priority: "urgent" });
  });

  it("moves to another column and marks the current one", async () => {
    const user = userEvent.setup();
    openMenu(makeCard());
    await openSub(user, /move to column/i);
    expect(await screen.findByRole("menuitemradio", { name: "todo" })).toBeChecked();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "doing" }));
    expect(actions.moveCard).toHaveBeenCalledWith("card-1", "doing", 0);
  });

  it("moves the card to another project in the same workspace", async () => {
    const user = userEvent.setup();
    openMenu(makeCard());
    await openSub(user, /move to project/i);
    expect(screen.queryByRole("menuitem", { name: "Alpha" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Beta" }));
    expect(actions.moveCardToProject).toHaveBeenCalledWith("card-1", "p2");
  });
});
