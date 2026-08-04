import { describe, it, expect, vi, beforeEach } from "vitest";

// 1. Mock electron at the very top to resolve module-level getPath calls
vi.mock("electron", () => {
  return {
    app: {
      getPath: (key: string) => {
        if (key === "userData") {
          return "/tmp/cairn-test-userdata";
        }
        return `/mock/${key}`;
      }
    },
    BrowserWindow: class {}
  };
});

// 2. Mock llama-server methods since we run in isolated unit tests
vi.mock("./llama-server", () => {
  return {
    isLlamaServerInstalled: vi.fn().mockReturnValue(true),
    ensureLlamaServerRunning: vi.fn().mockResolvedValue(65370),
    listModels: vi.fn().mockReturnValue([
      { id: "gemma-4-e2b-it-q4", name: "Gemma 4", status: "installed" }
    ])
  };
});

import { callLocalLLMChat, isLocalLLMAvailable, streamLocalLLMChat, continueLocalLLMAfterReasoning, LOCAL_LLM_MAX_TOKENS } from "./local-llm";

describe("Local LLM Router (Offline Local Llama/On-Device Router)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isLocalLLMAvailable", () => {
    it("returns available: true when llama-server is installed and models are downloaded", async () => {
      const { isLlamaServerInstalled, listModels } = await import("./llama-server");
      vi.mocked(isLlamaServerInstalled).mockReturnValue(true);
      vi.mocked(listModels).mockReturnValue([
        { id: "gemma-4-e2b-it-q4", name: "Gemma 4", filename: "gemma-4.gguf", path: "/path", repo: "repo", quant: "Q4", downloadUrl: "url", sizeBytes: 1000, status: "installed", downloadProgress: 100 }
      ]);

      const res = await isLocalLLMAvailable();
      expect(res.available).toBe(true);
    });

    it("returns available: false when llama-server is not installed", async () => {
      const { isLlamaServerInstalled } = await import("./llama-server");
      vi.mocked(isLlamaServerInstalled).mockReturnValue(false);

      const res = await isLocalLLMAvailable();
      expect(res.available).toBe(false);
      expect(res.reason).toContain("llama-server is not installed");
    });

    it("returns available: false when no models are downloaded", async () => {
      const { isLlamaServerInstalled, listModels } = await import("./llama-server");
      vi.mocked(isLlamaServerInstalled).mockReturnValue(true);
      vi.mocked(listModels).mockReturnValue([]);

      const res = await isLocalLLMAvailable();
      expect(res.available).toBe(false);
      expect(res.reason).toContain("No local on-device models downloaded");
    });
  });

  describe("callLocalLLMChat", () => {
    it("makes a local completions POST fetch call and returns data", async () => {
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
                          reason: "Related topics."
                        }
                      ]
                    })
                  }
                }
              ]
            }
          }
        ]
      };

      // Mock the global fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });
      global.fetch = mockFetch;

      const messages = [
        { role: "system" as const, content: "You are a helpful assistant." },
        { role: "user" as const, content: "Suggest some connections." }
      ];

      const tools = [
        {
          type: "function",
          function: {
            name: "suggest_connections",
            description: "Suggest links",
            parameters: { type: "object", properties: {} }
          }
        }
      ];

      const result = await callLocalLLMChat(messages, tools);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:65370/v1/chat/completions");
      expect(init.method).toBe("POST");
      
      const body = JSON.parse(init.body);
      expect(body.model).toBe("gemma-4");
      expect(body.messages).toHaveLength(2);
      expect(body.tools).toBeDefined();
      expect(body.max_tokens).toBe(LOCAL_LLM_MAX_TOKENS);

      expect(result).toEqual(mockResponse);
      const toolCall = result.choices[0].message.tool_calls[0];
      expect(toolCall.function.name).toBe("suggest_connections");
    });

    it("appends a continuation user message and returns the choice when content exhausts on reasoning", async () => {
      const contResponse = {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Final answer: ship it." }
          }
        ]
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => contResponse
      });
      global.fetch = mockFetch;

      const messages = [
        { role: "system" as const, content: "sys" },
        { role: "user" as const, content: "u" }
      ];

      const choice = await continueLocalLLMAfterReasoning(messages);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      // Continuation appends a non-reasoning instruction as the last user turn.
      expect(body.messages).toHaveLength(3);
      expect(body.messages[2].role).toBe("user");
      expect(body.messages[2].content).toMatch(/final.*answer/i);
      expect(body.max_tokens).toBe(LOCAL_LLM_MAX_TOKENS);
      expect(choice).toEqual(contResponse.choices[0]);
    });

    it("returns null on a non-OK continuation response (length-exhaustion fallback degrades to reasoning)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
      global.fetch = mockFetch;
      const choice = await continueLocalLLMAfterReasoning([{ role: "user", content: "x" }]);
      expect(choice).toBeNull();
    });
  });

  describe("streamLocalLLMChat", () => {
    it("sets the on-device max_tokens floor on the streaming body", async () => {
      const encoder = new TextEncoder();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) }
      });
      global.fetch = mockFetch;

      const gen = streamLocalLLMChat([{ role: "user", content: "hi" }]);
      // drain the generator
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) { /* just drain */ }

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.max_tokens).toBe(LOCAL_LLM_MAX_TOKENS);
      expect(body.stream).toBe(true);
    });
  });

  describe("On-Device XML-style Parser Regex", () => {
    it("successfully parses nested JSON arguments containing arrays and custom tokens", () => {
      const rawContent = `Based on your graph structure, here are some suggested connections:

<|tool_call>call:suggest_connections{connections:[{source_note_id:<|"|>4DE9JBdVsNuA<|"|>,target_note_id:<|"|>H4U25-U6N27L<|"|>,type:<|"|>link_note_note<|"|>},{source_note_id:<|"|>QicLuFrfQwqy<|"|>,target_note_id:<|"|>6k1gfpye1d7<|"|>,type:<|"|>link_note_note<|"|>}]}<tool_call|>

Hope this helps!`;

      const matches = [...rawContent.matchAll(/<\|tool_call>call:\s*([a-zA-Z0-9_-]+)(.*?)<tool_call\|>/gs)];
      expect(matches).toHaveLength(1);
      
      const match = matches[0];
      expect(match[1]).toBe("suggest_connections");
      
      let argsStr = match[2];
      argsStr = argsStr.replace(/<\|"\|>/g, '"');
      argsStr = argsStr.replace(/([{,]\s*)([a-zA-Z0-9_-]+)\s*:/g, '$1"$2":');
      
      const parsed = JSON.parse(argsStr);
      expect(parsed.connections).toBeDefined();
      expect(parsed.connections).toHaveLength(2);
      expect(parsed.connections[0].source_note_id).toBe("4DE9JBdVsNuA");
      expect(parsed.connections[1].target_note_id).toBe("6k1gfpye1d7");

      const cleanedContent = rawContent.replace(match[0], "").trim();
      expect(cleanedContent).not.toContain("<|tool_call>");
      expect(cleanedContent).toContain("Based on your graph");
      expect(cleanedContent).toContain("Hope this helps!");
    });
  });
});
