import { describe, it, expect } from "vitest";
import { buildChatCompletionsBody } from "./openai-body";
import type { OpenAIConfig } from "../ai-config";
import type { UIMessage } from "./types";

const config: OpenAIConfig = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

const msg = (role: "user" | "assistant", text: string): UIMessage => ({
  id: "m1",
  role,
  parts: [{ type: "text", text }],
});

describe("buildChatCompletionsBody", () => {
  it("omits temperature when options are absent (Auto = model default)", () => {
    const body = buildChatCompletionsBody(config, [msg("user", "hi")], {});
    expect(body.temperature).toBeUndefined();
    expect("temperature" in body).toBe(false);
  });

  it("omits temperature when the value is undefined (explicit Auto)", () => {
    const body = buildChatCompletionsBody(config, [msg("user", "hi")], {}, { temperature: undefined });
    expect("temperature" in body).toBe(false);
  });

  it("includes temperature when a value is set", () => {
    const body = buildChatCompletionsBody(config, [msg("user", "hi")], {}, { temperature: 0.7 });
    expect(body.temperature).toBe(0.7);
  });

  it("sends the model and messages", () => {
    const body = buildChatCompletionsBody(config, [msg("user", "hello")], {});
    expect(body.model).toBe("test-model");
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ role: "user", content: "hello" });
  });

  it("adds tools when provided", () => {
    const body = buildChatCompletionsBody(
      config,
      [msg("user", "hi")],
      { get_weather: { description: "Weather", jsonSchema: { type: "object" } } },
    );
    expect(body.tools).toBeDefined();
    const tools = body.tools as { function: { name: string } }[];
    expect(tools[0].function.name).toBe("get_weather");
  });

  it("keeps reasoning round-trip field when the message carries it", () => {
    const reasoningMsg: UIMessage = {
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
      reasoning: "thinking…",
      reasoningField: "reasoning_content",
    };
    const body = buildChatCompletionsBody(config, [reasoningMsg], {});
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0].reasoning_content).toBe("thinking…");
  });
});
