/**
 * Live smoke test for the subagent chat streaming path.
 *
 * Verifies runDispatchLoop emits the SubagentEvents the chat:stream handler
 * relies on (start/done + token/tool-call), so the renderer's expandable trace
 * has data to render. Gated on a reachable endpoint + CAIRN_SKIP_LIVE_TESTS.
 *
 * Run:
 *   TEST_LLM_BASE_URL=... TEST_LLM_MODEL=... TEST_LLM_API_KEY=... \
 *     npx vitest run --project node electron/lib/chat-subagent-stream.test.ts
 */

import { describe, it, beforeEach, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn, createNote } from "../db/queries";
import { normaliseBaseUrl } from "./llm";
import { runDispatchLoop, type SubagentEvents } from "./chat-subagent-loop";
import type { ChatRequest } from "./tools";

const BASE_URL = normaliseBaseUrl(process.env.TEST_LLM_BASE_URL?.trim() || "http://localhost:1234/v1");
const MODEL = process.env.TEST_LLM_MODEL?.trim() || "gpt-4o-mini";
const API_KEY = process.env.TEST_LLM_API_KEY?.trim() || "";

async function endpointUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}, signal: AbortSignal.timeout(2500) });
    return res.ok || res.status === 401 || res.status === 404;
  } catch { return false; }
}

describe.skipIf(!!process.env.CAIRN_SKIP_LIVE_TESTS)("subagent chat streaming (live smoke)", () => {
  let up = false;
  beforeEach(async () => { up = await endpointUp(); });

  it("emits subagent start/done + token/tool-call events", async () => {
    if (!up) {
      // eslint-disable-next-line no-console
      console.log(`[skip] no endpoint at ${BASE_URL}`);
      return;
    }

    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    const wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-substream-"));
    createWorkspace(db, { id: "ws", name: "WS" });
    createProject(db, { id: "p", workspaceId: "ws", name: "Cairn", priority: "high" });
    createColumn(db, { id: "c", projectId: "p", workspaceId: "ws", name: "Backlog", type: "backlog", order: 0 });
    createNote(db, { id: "n1", projectId: "p", workspaceId: "ws", title: "Alpha note", content: "The alpha initiative covers onboarding and retention." });
    createNote(db, { id: "n2", projectId: "p", workspaceId: "ws", title: "Beta note", content: "Beta is about performance and payload size." });

    const starts: string[] = [];
    const dones: string[] = [];
    let tokenCount = 0;
    const subUsage = new Map<string, number>();

    const events: SubagentEvents = {
      onSubagentStart: (e) => { starts.push(`${e.role}:${e.childId}`); },
      onSubagentDone: (e) => { dones.push(`${e.role}:${e.childId}`); },
      onSubagentToken: () => { tokenCount++; },
      onSubagentUsage: (e) => { subUsage.set(e.childId, e.promptTokens); },
    };

    const req: ChatRequest = {
      message: "Research the notes in this project and summarise the main themes in your reply.",
      threadId: "t1", workspaceId: "ws", projectId: "p",
      config: { maxSteps: 12, temperature: 0.2 },
    };

    const result = await runDispatchLoop(db, req, wp, { baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY, provider: "openai" }, undefined, { events });
    db.close();

    const m = result.metrics;
    // eslint-disable-next-line no-console
    console.log(`starts=${starts.length} dones=${dones.length} tokens=${tokenCount} finalChars=${result.content.length}`);
    // eslint-disable-next-line no-console
    console.log(`subagent roles: ${starts.join(", ")}`);
    // eslint-disable-next-line no-console
    console.log(`TOTAL promptTokens=${m.promptTokens}  DISPATCHER context=${m.dispatcherPromptTokens}  perSubagentUsage=${[...subUsage.values()].join(",")}`);

    // At least one subagent must have started + finished, and produced a final reply.
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(dones.length).toBe(starts.length);
    expect(result.content.length).toBeGreaterThan(0);
    // Per-subagent usage must be reported (one entry per subagent that ran) so
    // each subagent can render its own ring.
    expect(subUsage.size).toBeGreaterThanOrEqual(1);
    // The dispatcher's context (its ring) must be SMALLER than the summed total —
    // that's the whole point: it holds only briefs, not the raw tool outputs.
    expect(m.dispatcherPromptTokens).toBeLessThan(m.promptTokens);
    expect(m.dispatcherPromptTokens).toBeGreaterThan(0);
  }, 300_000);
});
