import { describe, it, expect, vi } from "vitest";
import { maybeTitleChat } from "./chat-title";
import type { TitleInputs } from "../../agent/session/history";
import type { LLMConfig } from "../../lib/llm";

const config: LLMConfig = { baseUrl: "http://localhost", model: "m", apiKey: "k" };

function fakeHost(inputs: TitleInputs) {
  return {
    titleInputs: vi.fn(async () => inputs),
    autoTitle: vi.fn(async (_id: string, title: string) => Boolean(title) && !inputs.userTitle),
  };
}

describe("maybeTitleChat", () => {
  it("names a thread from its first exchange with the chat's model and records it as auto", async () => {
    const host = fakeHost({ humanMessages: ["Help me plan the garden beds"], firstReply: "Here is a plan", autoTitles: 0 });
    const run = vi.fn(async () => 'Title: "Garden bed plan."');
    expect(await maybeTitleChat(host, "chat-1", config, { workspaceId: "ws" }, run)).toBe("Garden bed plan");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ config, source: "chat-title", sessionId: "chat-1" }));
    expect(host.autoTitle).toHaveBeenCalledWith("chat-1", "Garden bed plan", undefined);
  });

  it("does not call the model once the thread has been named", async () => {
    const host = fakeHost({ humanMessages: ["Help me plan the garden beds"], autoTitles: 0, userTitle: "Garden" });
    const run = vi.fn(async () => "x");
    expect(await maybeTitleChat(host, "chat-2", config, {}, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("records nothing when the reply is empty, and lets errors reach the caller", async () => {
    const host = fakeHost({ humanMessages: ["Help me plan the garden beds"], autoTitles: 0 });
    expect(await maybeTitleChat(host, "chat-3", config, {}, vi.fn(async () => '""'))).toBeUndefined();
    expect(host.autoTitle).not.toHaveBeenCalled();
    await expect(maybeTitleChat(host, "chat-3", config, {}, vi.fn(async () => { throw new Error("offline"); }))).rejects.toThrow("offline");
  });
});
