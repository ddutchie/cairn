// Diagnostic dumper for real session logs; heterogeneous event shapes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";

import { getContext } from "./run-cordis-loop";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";

describe("Inspect Active Session", () => {
  it("loads and analyzes chat-HTKCO2CQPuv0", async () => {
    const ctx = await getContext();
    const pers = (ctx as any).sessionPersistence;
    const list = await pers.list();

    console.log("Found sessions:", list);
    if (list.length === 0) return;
    const { deriveMessagesFromEvents, collapseDerivedToMessages } = await import("./session-replay");

    // dsh ≥0.1.5: inspect() is gone — read through an open read handle.
    const readSession = async (id: string) => {
      const handle = await pers.open(id, "read");
      try {
        const { events } = await handle.read(0, undefined);
        return { events: events as SessionEvent[] };
      } finally {
        await handle.close();
      }
    };
    let inspect: { events: Array<SessionEvent> };
    try {
      inspect = await readSession("chat-thr-live-2");
    } catch (error) {
      // Only an absent session is a skip — corruption/read/close failures
      // must fail the test, not pass silently.
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error;
      return; // session absent in this environment — nothing to analyze
    }
    const derived = deriveMessagesFromEvents(inspect.events);
    // Also dump the active chat-HTKCO2CQPuv0 session to scratch as a readable jsonl file
    const fs = await import("fs");
    const path = await import("path");
    try {
      const activeInspect = await readSession("chat-thr-live-2");
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
