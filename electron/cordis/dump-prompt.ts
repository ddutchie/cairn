/**
 * Cairn — inspection report generator for the assembled Cordis system prompt.
 *
 * NOT A TEST. This is a diagnostic script — it dumps the full rendered
 * system prompt, section breakdown, dynamic runtime contexts, discovered
 * skills, and tool-definition token estimates to `scratch/assembled-system-
 * prompt.md`. Used for prompt-audit work and for the "Assembled System
 * Prompt" preview in Agent Settings.
 *
 * Previously lived at electron/cordis/dump-prompt.test.ts, which failed on
 * any clean checkout because it wrote to `scratch/` without mkdirSync (and
 * `scratch/` is gitignored, so a fresh clone has no such dir) — plus it had
 * zero `expect()` calls so vitest counted it as passing when it silently
 * did nothing.
 *
 * Run with:
 *   npm run compile && node -r ts-node/register electron/cordis/dump-prompt.ts
 * or, simpler:
 *   npx tsx electron/cordis/dump-prompt.ts
 */

import fs from "fs";
import path from "path";
import { getContext } from "./run-cordis-loop";
import { buildSystemPrompt, TOOLS } from "../lib/tools";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

async function main(): Promise<void> {
  const ctx = await getContext();
  const sys = (ctx as unknown as { systemPrompt: { section: (o: unknown) => (() => void) | undefined; assemble: (o: unknown) => Promise<unknown> } }).systemPrompt;

  const sampleReq = {
    message: "Summarize this project",
    threadId: "inspect-thread",
    projectId: "proj-sample",
    workspaceId: "ws-sample",
  };

  const cairnBase = buildSystemPrompt(sampleReq as never);
  const dispose = sys.section({ name: "cairn:system", order: -100, text: cairnBase });

  const assembly = (await sys.assemble({})) as { sections?: unknown[]; contexts?: unknown[] };
  const renderedText = renderPrompt(assembly as never);

  const textOf = (v: unknown): string => (typeof v === "function" ? (v as () => string)() : (v as string));

  const sections = (assembly.sections ?? []).map((s: unknown, idx: number) => {
    const sec = s as { name: string; text: unknown };
    return {
      index: idx,
      name: sec.name,
      charLength: textOf(sec.text)?.length ?? 0,
      estimatedTokens: Math.round((textOf(sec.text)?.length ?? 0) / 4),
      text: textOf(sec.text),
    };
  });

  const contexts = (assembly.contexts ?? []).map((c: unknown, idx: number) => {
    const ctx = c as { name: string; order: number; text: unknown };
    return {
      index: idx,
      name: ctx.name,
      order: ctx.order,
      charLength: textOf(ctx.text)?.length ?? 0,
      estimatedTokens: Math.round((textOf(ctx.text)?.length ?? 0) / 4),
      text: textOf(ctx.text),
    };
  });

  let skillsList: Array<{ name: string; description: string }> = [];
  try {
    const skillsSvc = (ctx as unknown as { skills?: { list: (o: unknown) => Promise<Array<{ name: string; description: string }>> } }).skills;
    if (skillsSvc) skillsList = await skillsSvc.list({ cwd: process.cwd() });
  } catch { /* skills is optional */ }

  const toolDefinitionsJson = JSON.stringify(TOOLS, null, 2);
  const toolDefsTokensEst = Math.round(toolDefinitionsJson.length / 4);

  let md = `# Cordis System Prompt & Request Payload Inspection

Generated at: ${new Date().toISOString()}

## Executive Summary
- **Rendered System Prompt Length**: ${renderedText.length} chars (~${Math.round(renderedText.length / 4)} tokens)
- **Total Prompt Sections**: ${sections.length}
- **Total Dynamic Context Providers**: ${contexts.length}
- **Discovered Skills**: ${skillsList.length}
- **Registered Cairn Tools**: ${TOOLS.length} (~${toolDefsTokensEst} tokens in schema parameters)

---

## 1. Assembled System Prompt (Full Text)

\`\`\`markdown
${renderedText}
\`\`\`

---

## 2. Prompt Sections Breakdown (${sections.length} sections)

`;

  for (const sec of sections) {
    md += `### Section #${sec.index + 1}: \`${sec.name}\`
- **Length**: ${sec.charLength} chars (~${sec.estimatedTokens} tokens)

\`\`\`markdown
${sec.text}
\`\`\`

`;
  }

  md += `---

## 3. Dynamic Runtime Contexts (${contexts.length} contexts)

These are injected as \`user/form:snapshot\` messages by DSH when dynamic context updates:

`;

  for (const c of contexts) {
    md += `### Context: \`${c.name}\` (Order: ${c.order})
- **Length**: ${c.charLength} chars (~${c.estimatedTokens} tokens)

\`\`\`markdown
${c.text}
\`\`\`

`;
  }

  md += `---

## 4. Discovered Skills (${skillsList.length} skills)

Injected on step 1 by \`@deepseek-ai/dsh-tool-skill\` inside \`<available_skills>\`:

`;

  for (const s of skillsList) md += `- **\`${s.name}\`**: ${s.description}\n`;

  md += `

---

## 5. Tool Definitions Summary (${TOOLS.length} tools ~${toolDefsTokensEst} tokens)

| Tool Name | Parameters Schema Tokens (est) | Description |
|-----------|-------------------------------|-------------|
`;

  for (const t of TOOLS as Array<{ function?: { name: string; parameters?: unknown; description?: string } }>) {
    const fn = t.function ?? { name: "?", parameters: {}, description: "" };
    const schemaStr = JSON.stringify(fn.parameters ?? {});
    md += `| \`${fn.name}\` | ~${Math.round(schemaStr.length / 4)} | ${fn.description?.slice(0, 80) ?? ""}... |\n`;
  }

  const outDir = path.resolve(__dirname, "../../scratch");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "assembled-system-prompt.md");
  fs.writeFileSync(outPath, md, "utf-8");
  // eslint-disable-next-line no-console
  console.log(`Wrote inspection report to ${outPath}`);

  dispose?.();
}

// Run when invoked directly (node/tsx). No side effects on import so unit
// tests that import `main` for coverage don't fire the whole assembly.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[dump-prompt] failed:", err);
    process.exit(1);
  });
}
