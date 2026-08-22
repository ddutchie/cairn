import { describe, it, expect } from "vitest";

import { getContext } from "./run-cordis-loop";
import { SessionId } from "@deepseek-ai/dsh-session";
import { foldSessionUsage } from "./plugins/context-ring";

describe("Inspect Active Session", () => {
  it("loads and analyzes chat-HTKCO2CQPuv0", async () => {
    const sessionDir = "/Users/gerard/Library/Application Support/Electron/sessions/--Users-gerard-Documents-Cairn--";
    const ctx = await getContext();
    const pers = (ctx as any).sessionPersistence;
    const list = await pers.list();

    console.log("Found sessions:", list);
    if (list.length === 0) return;
    const { deriveMessagesFromEvents, collapseDerivedToMessages, loadSessionMessages } = await import("./session-replay");

    const inspect = await pers.inspect("chat-thr-live-2");
    const derived = deriveMessagesFromEvents(inspect.events);
    // Also dump the active chat-HTKCO2CQPuv0 session to scratch as a readable jsonl file
    const fs = await import("fs");
    const path = await import("path");
    try {
      const activeInspect = await pers.inspect("chat-thr-live-2");
      if (activeInspect && activeInspect.events) {
        const dumpPath = path.resolve(__dirname, "../../scratch/recent-session-chat-thr-live-2.jsonl");
        fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
        const lines = activeInspect.events.map((ev: unknown) => JSON.stringify(ev)).join("\n");
        fs.writeFileSync(dumpPath, lines, "utf8");
        console.log(`Wrote ${activeInspect.events.length} session events to ${dumpPath}`);
      }
    } catch {
      // Ignored if session is absent in test environment
    }


    const replayed = collapseDerivedToMessages(derived);
    expect(replayed.length).toBeGreaterThan(0);
    const withTools = replayed.filter((m) => m.toolCalls && m.toolCalls.length > 0);
    expect(withTools.length).toBeGreaterThan(0);
    for (const m of withTools) {
      for (const tc of m.toolCalls!) {
        expect(tc.output).toBeDefined();
        expect(tc.ok).toBe(true);
      }
    }





  });
});
