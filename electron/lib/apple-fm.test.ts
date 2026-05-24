import { describe, it, expect, vi, beforeEach } from "vitest";
import { callAppleFMChat, isAppleFMAvailable } from "./apple-fm";

// Mock the tsfm-sdk module with ES6 class
vi.mock("tsfm-sdk", () => {
  class SystemLanguageModel {
    isAvailable() {
      return { available: true };
    }
  }
  return {
    SystemLanguageModel,
    SystemLanguageModelUnavailableReason: {
      APPLE_INTELLIGENCE_NOT_ENABLED: "apple_intelligence_not_enabled",
      DEVICE_NOT_ELIGIBLE: "device_not_eligible",
      MODEL_NOT_READY: "model_not_ready",
    },
  };
});

// Mock the tsfm-sdk/chat module with ES6 class
const mockCreate = vi.fn();
vi.mock("tsfm-sdk/chat", () => {
  class ChatClient {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  }
  return {
    default: ChatClient,
  };
});

describe("Apple Foundation Models Integration", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe("isAppleFMAvailable", () => {
    it("returns available: true when running on Darwin and SDK returns available", async () => {
      // Mock platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      const res = await isAppleFMAvailable();
      expect(res.available).toBe(true);

      // Restore platform
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("returns available: false on non-Darwin platforms", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });

      const res = await isAppleFMAvailable();
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/requires macOS/);

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });

  describe("callAppleFMChat", () => {
    it("calls tsfm chat completions with formatted tools and messages", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I recommend some connections.",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "suggest_connections",
                    arguments: JSON.stringify({
                      actions: [
                        {
                          type: "add_wikilink",
                          sourceNoteId: "n1",
                          sourceTitle: "Note A",
                          targetTitle: "Note B",
                          reason: "They are closely related topics.",
                        },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
      mockCreate.mockResolvedValue(mockResponse);

      const messages = [
        { role: "system" as const, content: "You are an assistant." },
        { role: "user" as const, content: "Suggest some connections." },
      ];

      const tools = [
        {
          type: "function",
          function: {
            name: "suggest_connections",
            description: "Emit connection actions",
            parameters: {
              type: "object",
              properties: { actions: { type: "array", items: { type: "object" } } },
            },
          },
        },
      ];

      const result = await callAppleFMChat(messages, tools);

      expect(mockCreate).toHaveBeenCalledWith({
        messages: [
          { role: "system", content: "You are an assistant." },
          { role: "user", content: "Suggest some connections." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "suggest_connections",
              description: "Emit connection actions",
              parameters: {
                type: "object",
                properties: { actions: { type: "array", items: { type: "object" } } },
              },
            },
          },
        ],
        stream: false,
      });

      expect(result).toEqual(mockResponse);
      const toolCall = result.choices[0].message.tool_calls[0];
      expect(toolCall.function.name).toBe("suggest_connections");
      const parsedArgs = JSON.parse(toolCall.function.arguments);
      expect(parsedArgs.actions[0].type).toBe("add_wikilink");
    });
  });
});
