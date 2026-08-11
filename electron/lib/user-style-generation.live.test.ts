/**
 * Cairn — Writing Style generation live test
 *
 * Drives the EXACT code path the wizard uses (`generateUserStyleMarkdown` in
 * ipc/user-style-handlers.ts → buildUserStyleFullGuidePrompt + callLLM +
 * isUsableGuide gate + retry) against a real endpoint, and asserts both the
 * FULL guide and the CHEAT SHEET come back as usable structured markdown —
 * not "token soup".
 *
 * Uses the repo's standard live-test convention (bench-endpoint):
 *   CAIRN_LIVE_TESTS=1 \
 *   TEST_LLM_BASE_URL=... TEST_LLM_MODEL=... TEST_LLM_API_KEY=... \
 *   npx vitest run electron/lib/user-style-generation.live.test.ts
 *
 * To reproduce a user's in-app setup (e.g. the ocgo proxy + deepseek-v4-flash),
 * point TEST_LLM_* at that endpoint/model/key. The scenario mirrors what a real
 * user does: persona + pasted samples (including a long document), no gap
 * answers.
 */

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createNote, createColumn } from "../db/queries";
import { runToolLoop } from "./chat-loop";
import { TOOLS } from "./tools";
import { generateUserStyleMarkdown, isUsableGuide } from "../ipc/user-style-handlers";
import type { UserStyleGenerationInput } from "./user-style-prompt";
import { buildUserStyleFullGuidePrompt } from "./user-style-prompt";
import { BASE_URL, MODEL, API_KEY, endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import type { LLMConfig } from "./llm";

const config: LLMConfig = { provider: "openai", baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY };

// Mirrors ipc/user-style-handlers.ts — read-only tools for the analyse path.
const WRITING_STYLE_TOOLS = new Set([
  "get_project_context_pack", "search_notes", "get_note", "search_tasks", "get_task",
]);

/** Realistic sample set — technical, DM, and a long pasted doc (caps exercise). */
function realisticInput(): UserStyleGenerationInput {
  return {
    persona: { name: "Alex", role: "Engineering lead", context: "Health-tech startup", audiences: "engineers, execs, customers" },
    samples: [
      {
        context: "Technical reply",
        text: "not a crash, just a timing assertion. Flaky on slow CI, which is why the prior runs passed. Fix in #3040: preload outside the lock so swaps aren't starved. Its one of the last blockers remaining so it needs to get in to test.",
      },
      {
        context: "Team message / DM",
        text: "On it. Will fix. Also - why are you working at 6am? Keep me posted and happy to answer any questions.",
      },
      {
        context: "Pasted document (long)",
        text: Array.from({ length: 8 }, (_, i) => `### Section ${i + 1}\nThis is a longer block of prose the user pasted in — describing how they write, format, open messages, close them, give feedback, and what to avoid. They use plain hyphens, never em-dashes. Warm and direct, praise then a concrete ask. Sign off with 'Keep me posted'.`).join("\n\n"),
      },
    ],
    answers: [],
  };
}

describe.skipIf(!LIVE_TESTS_ENABLED)("Writing Style generation (live)", () => {
  let up = false;
  beforeAll(async () => { up = await endpointUp(); });

  it("produces a usable FULL guide from samples (not token soup)", async () => {
    if (!up) {
      console.log(`[skip] No LLM endpoint reachable at ${BASE_URL}. Set TEST_LLM_BASE_URL/MODEL/API_KEY to run.`);
      return;
    }
    const markdown = await generateUserStyleMarkdown(config, "full", realisticInput());
    console.log(`\n=== FULL guide (${MODEL}) — ${markdown.length} chars, ${(markdown.match(/^\s*#{1,2}\s+/gm) ?? []).length} headings ===\n${markdown.slice(0, 600)}…`);
    expect(isUsableGuide(markdown, "full")).toBe(true);
  }, 300_000);

  it("produces a usable CHEAT SHEET from the generated full guide", async () => {
    if (!up) {
      console.log("[skip] endpoint not reachable.");
      return;
    }
    const full = await generateUserStyleMarkdown(config, "full", realisticInput());
    const cheat = await generateUserStyleMarkdown(config, "cheatsheet", { ...realisticInput(), fullGuide: full });
    console.log(`\n=== CHEAT SHEET (${MODEL}) — ${cheat.length} chars, ${(cheat.match(/^\s*#{1,2}\s+/gm) ?? []).length} headings ===\n${cheat.slice(0, 600)}…`);
    expect(isUsableGuide(cheat, "cheatsheet")).toBe(true);
    expect(cheat.length).toBeLessThan(full.length * 2); // condensed, not a rewrite
  }, 300_000);

  it("streams through runToolLoop with the read-only tools and produces a usable guide (analyse path)", async () => {
    if (!up) {
      console.log("[skip] endpoint not reachable.");
      return;
    }

    // Seed a tiny workspace so search_notes/get_note have real content.
    const db = new Database(":memory:");
    applySchema(db);
    createWorkspace(db, { id: "ws", name: "WS" });
    createProject(db, { id: "proj", workspaceId: "ws", name: "Demo", description: "", priority: "medium" });
    createColumn(db, { id: "col", projectId: "proj", workspaceId: "ws", name: "Todo", type: "todo", order: 0 });
    createNote(db, { id: "n1", projectId: "proj", workspaceId: "ws", title: "Alpha", content: "We write terse, warm notes. Plain hyphens, never em-dashes. Praise first, then a concrete ask." });
    createNote(db, { id: "n2", projectId: "proj", workspaceId: "ws", title: "Beta", content: "Squad chats are lowercase and quick. Sign off 'Keep me posted'." });

    try {
      const input = realisticInput();
      const systemPrompt = "You are a writing-style analyst and editor. Produce a precise, evidence-based writing style guide from the user's real writing. Follow the structure in the user prompt exactly. Write in clean, well-formed Markdown with ## headings.";
      const userPrompt = buildUserStyleFullGuidePrompt(input) +
        "\n\n## Active context\nProject: Demo\nWorkspace ID: ws\nProject ID: proj\nRead the user's notes with search_notes/get_note (scope to project proj) to ground the guide.";
      const req = { message: userPrompt, threadId: "us-test", workspaceId: "ws", projectId: "proj", config: { maxSteps: 4, temperature: 0.3 } };
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ];
      const toolsOverride = TOOLS.filter((t) => WRITING_STYLE_TOOLS.has(t.function.name));

      const tokens: string[] = [];
      const toolCalls: string[] = [];
      const result = await runToolLoop(
        db, req as never, "/tmp", BASE_URL, MODEL, API_KEY, messages,
        (e) => toolCalls.push(e.tool),
        undefined, undefined, "openai",
        undefined, undefined,
        (d) => tokens.push(d),
        undefined,
        [],
        toolsOverride,
      );
      const content = result.content;
      console.log(`\n=== STREAMED (${MODEL}) — ${content.length} chars, ${(content.match(/^\s*#{1,2}\s+/gm) ?? []).length} headings, toolCalls=[${toolCalls.join(",") || "none"}] ===\n${content.slice(0, 400)}…`);
      expect(tokens.length).toBeGreaterThan(0);        // actually streamed
      expect(toolCalls).toContain("search_notes");     // used the read-only tools
      expect(isUsableGuide(content, "full")).toBe(true);
    } finally {
      db.close();
    }
  }, 300_000);
});
