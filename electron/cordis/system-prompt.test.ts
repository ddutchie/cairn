/**
 * Cairn — smoke test for the assembled Cordis system prompt.
 *
 * Replaces the pre-existing dump-prompt.test.ts, which had zero
 * `expect()` calls and failed on any clean checkout because it wrote to
 * `scratch/` without mkdirSync. The full inspection report generator
 * moved to electron/cordis/dump-prompt.ts (a script, not a test).
 *
 * This test asserts the minimum property we actually care about: the
 * shared Cordis context can assemble a system prompt with Cairn's own
 * `cairn:system` section registered and dsh renders it non-empty.
 */

import { describe, it, expect } from "vitest";
import { getContext } from "./run-cordis-loop";
import { buildSystemPrompt, TOOLS } from "../lib/tools";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

describe("system prompt assembly", () => {
  it("renders a non-empty prompt with the cairn:system section registered", async () => {
    const ctx = await getContext();
    const sys = (ctx as unknown as {
      systemPrompt: {
        section: (o: unknown) => (() => void) | undefined;
        assemble: (o: unknown) => Promise<{ sections?: unknown[] }>;
      };
    }).systemPrompt;

    const cairnBase = buildSystemPrompt({
      message: "Summarize this project",
      threadId: "smoke-thread",
      projectId: "smoke-proj",
      workspaceId: "smoke-ws",
    } as never);
    const dispose = sys.section({ name: "cairn:system", order: -100, text: cairnBase });

    const assembly = await sys.assemble({});
    const rendered = renderPrompt(assembly as never);

    expect(rendered.length).toBeGreaterThan(100);
    expect(Array.isArray(assembly.sections)).toBe(true);
    const names = (assembly.sections ?? []).map((s) => (s as { name: string }).name);
    expect(names).toContain("cairn:system");

    // Every Cairn tool needs an OpenAI-style function shape — a stray
    // registration missing `name` would poison the schema. Cheap invariant.
    for (const t of TOOLS as Array<{ function?: { name?: string } }>) {
      expect(t.function?.name, JSON.stringify(t).slice(0, 80)).toBeTruthy();
    }

    dispose?.();
  });
});
