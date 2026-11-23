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

  it("looks again after a turn that ended while the first request was still running", async () => {
    let inputs: TitleInputs = { humanMessages: ["hi"], firstReply: "Hello", autoTitles: 0 };
    const titles: string[] = [];
    const host = {
      titleInputs: vi.fn(async () => inputs),
      autoTitle: vi.fn(async (_id: string, title: string) => { titles.push(title); inputs = { ...inputs, autoTitles: inputs.autoTitles + 1 }; return true; }),
    };
    let releaseFirst!: (v: string) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(async () => "Garden bed plan");
    const first = maybeTitleChat(host, "chat-4", config, {}, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // The second turn finishes while the greeting is still being named.
    inputs = { humanMessages: ["hi", "Help me plan the garden beds"], firstReply: "Hello", autoTitles: 0 };
    expect(await maybeTitleChat(host, "chat-4", config, {}, run)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1); // never two model calls at once
    releaseFirst("Greeting");
    await first;
    expect(run).toHaveBeenCalledTimes(2);
    expect(titles).toEqual(["Greeting", "Garden bed plan"]);
    // The second request names the conversation from both messages.
    expect(JSON.stringify(run.mock.calls[1][0])).toContain("garden beds");
  });

  it("still retries a greeting when a third turn also ended while the first request ran", async () => {
    let inputs: TitleInputs = { humanMessages: ["hi"], firstReply: "Hello", autoTitles: 0 };
    const host = {
      titleInputs: vi.fn(async () => inputs),
      autoTitle: vi.fn(async () => { inputs = { ...inputs, autoTitles: inputs.autoTitles + 1 }; return true; }),
    };
    let releaseFirst!: (v: string) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(async () => "Garden bed plan");
    const first = maybeTitleChat(host, "chat-5", config, {}, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    inputs = { humanMessages: ["hi", "Help me plan the garden beds"], firstReply: "Hello", autoTitles: 0 };
    await maybeTitleChat(host, "chat-5", config, {}, run);
    inputs = { humanMessages: ["hi", "Help me plan the garden beds", "and the shed"], firstReply: "Hello", autoTitles: 0 };
    await maybeTitleChat(host, "chat-5", config, {}, run);
    releaseFirst("Greeting");
    await first;
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(run.mock.calls[1][0])).toContain("garden beds");
  });
});
