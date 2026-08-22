import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { foldSessionUsage, foldContextRing, foldSessionTodos } from "./plugins/context-ring";
import { collapseDerivedToMessages } from "./session-replay";
import { foldSurface, deriveEventMessage, type SessionEvent } from "@deepseek-ai/dsh-session";

function loadJsonlEvents(filePath: string): SessionEvent[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, idx) => {
      const parsed = JSON.parse(line);
      return { ...parsed, seq: parsed.seq ?? idx } as SessionEvent;
    });
}


describe("Context Ring & Replay on real saved jsonl sessions", () => {
  it("folds usage, tool outputs, and breakdown correctly on cordis-tool-round session", () => {
    const jsonlPath = path.resolve(
      __dirname,
      "../../scratch/dsh-repo/apps/web/tests/snapshots/cordis-tool-round/session.jsonl"
    );
    if (!fs.existsSync(jsonlPath)) return;

    const events = loadJsonlEvents(jsonlPath);
    expect(events.length).toBeGreaterThan(0);

    const usage = foldSessionUsage(events);
    expect(usage).toBeDefined();
    if (usage) {
      console.log("Folded Usage from cordis-tool-round:", {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        breakdown: usage.breakdown,
      });

      expect(usage.promptTokens).toBeGreaterThan(0);
      expect(usage.breakdown).toBeDefined();
      expect(usage.breakdown?.systemPrompt).toBeGreaterThan(0);
      expect(usage.breakdown?.conversation).toBeGreaterThanOrEqual(0);
    }
  });


  it("folds realistic multi-turn session with tools and reasoning", () => {
    const events: SessionEvent[] = [
      {
        seq: 0,
        type: "user/message",
        data: {
          role: "user",
          content: [{ type: "text", text: "Summarize this project" }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      } as any,
      {
        seq: 1,
        type: "user/message",
        data: {
          role: "user",
          content: [{ type: "text", text: "<system-reminder> Available skills... </system-reminder>" }],
          source: { kind: "plugin", plugin: "dsh-tool-skill", form: "catalog" },
        },
        surfaceOp: "append",
      } as any,
      {
        seq: 2,
        type: "assistant/chunk",
        data: {
          chunk: {
            type: "usage",
            usage: {
              promptTokens: 12500,
              completionTokens: 1200,
              reasoningTokens: 789,
              costUsd: 0.0042,
              cacheReadTokens: 1024,
            },
          },
        },
      } as any,
      {
        seq: 3,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Thinking about the project structure..." },
              { type: "tool-call", id: "call-1", name: "get_active_context", arguments: {} },
            ],
            source: { provider: "deepseek", model: "deepseek-reasoner" },
          },
        },
        surfaceOp: "append",
      } as any,
      {
        seq: 4,
        type: "tool/result",
        data: {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                content: [{ type: "text", text: JSON.stringify({ workspaceId: "ws-1", projectId: "proj-1", notes: ["note-1", "note-2"] }) }],
              },
            ],
          },
        },
        surfaceOp: "append",
      } as any,
      {
        seq: 5,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Now writing note..." },
              { type: "text", text: "I have created the project summary note." },
            ],
            source: { provider: "deepseek", model: "deepseek-reasoner" },
          },
        },
        surfaceOp: "append",
      } as any,
    ];

    const usage = foldSessionUsage(events);
    expect(usage).toBeDefined();
    console.log("Folded Usage Result:", usage);

    expect(usage?.promptTokens).toBe(12500);
    expect(usage?.completionTokens).toBe(1200);
    expect(usage?.reasoningTokens).toBe(789);
    expect(usage?.costUsd).toBe(0.0042);
    expect(usage?.cacheReadTokens).toBe(1024);

    // Breakdown
    expect(usage?.breakdown?.systemPrompt).toBe(350);
    expect(usage?.breakdown?.tools).toBe(2650);
    expect(usage?.breakdown?.toolOutputs).toBeGreaterThan(0);
    expect(usage?.breakdown?.conversation).toBeGreaterThan(0);


    // Derived messages
    const { nodes } = foldSurface(events);
    const derived = nodes
      .map((seq) => deriveEventMessage(events[seq]))
      .filter((m): m is NonNullable<ReturnType<typeof deriveEventMessage>> => m !== null);

    const replayed = collapseDerivedToMessages(derived as any);
    console.log("Replayed Messages:", replayed);

    // Test get_note cairnRef extraction
    const noteEvents = [
      {
        seq: 0,
        type: "user/message",
        data: { role: "user", content: [{ type: "text", text: "get the note" }], source: { kind: "user" } },
        surfaceOp: "append",
      },
      {
        seq: 1,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Reading note..." },
              { type: "tool-call", id: "call-note-1", name: "get_note", arguments: { noteId: "za_DVhlioFn_" } },
            ],
            source: { provider: "deepseek", model: "deepseek-reasoner" },
          },
        },
        surfaceOp: "append",
      },
      {
        seq: 2,
        type: "tool/result",
        data: {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-note-1",
                content: [{ type: "text", text: JSON.stringify({ id: "za_DVhlioFn_", title: "Plugin idea: Context Ring", content: "..." }) }],
              },
            ],
          },
        },
        surfaceOp: "append",
      },
      {
        seq: 3,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I fetched note za_DVhlioFn_." },
            ],
            source: { provider: "deepseek", model: "deepseek-reasoner" },
          },
        },
        surfaceOp: "append",
      },
    ];

    const noteDerived = foldSurface(noteEvents as any).nodes
      .map((seq) => deriveEventMessage(noteEvents[seq] as any))
      .filter((m): m is NonNullable<ReturnType<typeof deriveEventMessage>> => m !== null);

    const noteReplayed = collapseDerivedToMessages(noteDerived as any);
    console.log("Note Replayed Messages:", JSON.stringify(noteReplayed, null, 2));

    expect(noteReplayed.length).toBe(2);
    expect(noteReplayed[1].toolCalls?.length).toBe(1);
    expect(noteReplayed[1].toolCalls?.[0].tool).toBe("get_note");
    expect(noteReplayed[1].toolCalls?.[0].cairnRef).toEqual({
      type: "note",
      id: "za_DVhlioFn_",
      title: "Plugin idea: Context Ring",
    });
  });

  it("folds request/context event and extracts model contextWindow capacity", () => {
    const events: Array<{ type: string; seq?: number; data?: unknown; surfaceOp?: unknown }> = [
      {
        seq: 0,
        type: "request/context",
        data: {
          provider: "cairn",
          model: "claude-3-7-sonnet",
          contextWindow: 200000,
        },
      },
      {
        seq: 1,
        type: "assistant/message",
        data: {
          usage: {
            inputTokens: 15000,
            outputTokens: 500,
          },
          message: {
            content: [{ type: "text", text: "Hello!" }],
            source: { model: "claude-3-7-sonnet" },
          },
        },
        surfaceOp: "append",
      },
    ];

    const usage = foldSessionUsage(events as any);
    expect(usage).toBeDefined();
    expect(usage?.promptTokens).toBe(15000);
    expect(usage?.contextLimit).toBe(200000);
    expect(usage?.contextWindow).toBe(200000);
  });
});


