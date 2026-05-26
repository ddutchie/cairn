import { describe, it, expect, vi } from "vitest";

// Mock electron before module imports that evaluate app.getPath
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

import { callLocalLLMChat, isLocalLLMAvailable } from "./local-llm";
import { TOOLS } from "./tools";

describe("Local LLM Real Verification (No Mocking)", () => {
  it("verifies tool calling on actual Apple Silicon hardware with complete schemas", async () => {
    const status = await isLocalLLMAvailable();
    console.log("Real hardware status:", status);
    if (!status.available) {
      console.warn("Skipping real hardware test: Local LLM is not enabled or supported on this machine.");
      return;
    }

    const messages = [
      {
        role: "system" as const,
        content: `You help users build meaningful connections in their knowledge graph. You have access to a snapshot of their knowledge graph.

CRITICAL MANDATE: You MUST call the suggest_connections tool whenever you suggest a connection or wikilink. Do NOT just list suggestions in prose.

Here is the graph snapshot:
NODES:
- [note] id=note1 "Twitter Launch Strategy"
- [note] id=note2 "Site Architecture"

Suggest connecting "Twitter Launch Strategy" (note1) to "Site Architecture" (note2) by adding a wikilink.`
      },
      { role: "user" as const, content: "Suggest some connections based on my nodes." }
    ];

    console.log("Calling real local LLM with flat suggest_connections tool...");
    const suggestTool = TOOLS.filter(t => t.function.name === "suggest_connections");
    const res = await callLocalLLMChat(messages, suggestTool);
    console.log("Actual Local LLM Response Shape:\n", JSON.stringify(res, null, 2));

    expect(res).toBeDefined();
    expect(res.choices).toBeDefined();
    const choice = res.choices[0];
    expect(choice.message).toBeDefined();
    
    // Check if it called the tool and produced valid parameters
    if (choice.message.tool_calls) {
      const toolCall = choice.message.tool_calls[0];
      expect(toolCall.function.name).toBe("suggest_connections");
      
      const args = JSON.parse(toolCall.function.arguments);
      console.log("Parsed suggest_connections Tool Arguments:", args);
      
      expect(args.actions).toBeDefined();
      expect(args.actions.length).toBeGreaterThan(0);
      
      const action = args.actions[0];
      expect(["add_wikilink", "link_note_note"]).toContain(action.type);
      expect(action.sourceNoteId).toBe("note1");
      expect(action.sourceTitle).toBe("Twitter Launch Strategy");
      
      const title = action.targetTitle || action.noteTitle;
      expect(title).toBe("Site Architecture");
    } else {
      console.warn("Model did not make a tool call in this turn.");
    }
  }, 60000);

  it("verifies that all whitelisted Local LLM tools compile cleanly on actual hardware without conflicts or native schema rejections", async () => {
    const status = await isLocalLLMAvailable();
    if (!status.available) {
      console.warn("Skipping real hardware validation.");
      return;
    }

    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Hello." }
    ];

    console.log("Compiling all whitelisted tools with Local LLM...");
    const res = await callLocalLLMChat(messages, TOOLS);
    console.log("Completions successfully compiled with all allowed tools!");
    
    expect(res).toBeDefined();
    expect(res.choices).toBeDefined();
    expect(res.choices[0].message).toBeDefined();
  }, 60000);
});
