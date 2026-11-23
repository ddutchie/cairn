/* eslint-disable @typescript-eslint/no-explicit-any */
/** A title set live while a chat load is still reading sessions isn't overwritten by the load. */
import { describe, it, expect, vi } from "vitest";

const ipc = vi.hoisted(() => ({ release: null as null | (() => void) }));
vi.mock("../ipc", () => ({
  ipc: vi.fn(),
  ipcAwait: vi.fn(),
  ipcData: vi.fn(),
  ipcResult: vi.fn(async (call: (e: any) => Promise<any>) => {
    const e = {
      chat: {
        threads: async () => ({ data: [{ id: "t1", workspaceId: "ws", title: "First line", updatedAt: "1" }] }),
        // The session read finishes only when the test lets it, after a live title has arrived.
        sessionMessages: () => new Promise((resolve) => { ipc.release = () => resolve({ data: { messages: [], title: "Old session title" } }); }),
      },
    };
    return call(e);
  }),
}));

import { createChatSlice } from "./chat";

describe("loadChatFromDb titles", () => {
  it("keeps a title projected while the load was reading sessions", async () => {
    let state: any = { persist: () => {}, activeWorkspaceId: "ws", chatThreads: [], chatMessages: [], projectedTitles: {} };
    const set = (u: any) => { state = { ...state, ...(typeof u === "function" ? u(state) : u) }; };
    state = { ...state, ...createChatSlice(set, () => state, {} as any) };

    const load = state.loadChatFromDb("ws");
    await vi.waitFor(() => expect(ipc.release).toBeTruthy());
    state.setProjectedTitle("t1", "Newer title");
    ipc.release!();
    await load;

    expect(state.projectedTitles.t1).toBe("Newer title");
    expect(state.chatThreads.find((t: any) => t.id === "t1")?.title).toBe("Newer title");
  });
});
