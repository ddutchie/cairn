import { describe, it } from "vitest";
import fs from "fs";
import path from "path";
import { getContext } from "./run-cordis-loop";
import { buildSystemPrompt, TOOLS } from "../lib/tools";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

describe("Dump Assembled System Prompt & Sections", () => {
  it("assembles and writes inspection markdown file", async () => {
    const ctx = await getContext();
    const sys = (ctx as any).systemPrompt;

    const sampleReq = {
      message: "Summarize this project",
      threadId: "inspect-thread",
      projectId: "proj-sample",
      workspaceId: "ws-sample",
    };

    const cairnBase = buildSystemPrompt(sampleReq as any);

    const dispose = sys.section({
      name: "cairn:system",
      order: -100,
      text: cairnBase,
    });

    const assembly = await sys.assemble({});
    const renderedText = renderPrompt(assembly);

    const textOf = (v: any) => (typeof v === "function" ? v({}) : v);

    const sections = (assembly.sections || []).map((s: any, idx: number) => ({
      index: idx,
      name: s.name,
      charLength: textOf(s.text)?.length ?? 0,
      estimatedTokens: Math.round((textOf(s.text)?.length ?? 0) / 4),
      text: textOf(s.text),
    }));

    const contexts = (assembly.contexts || []).map((c: any, idx: number) => ({
      index: idx,
      name: c.name,
      order: c.order,
      charLength: textOf(c.text)?.length ?? 0,
      estimatedTokens: Math.round((textOf(c.text)?.length ?? 0) / 4),
      text: textOf(c.text),
    }));

    let skillsList: any[] = [];
    try {
      const skillsSvc = (ctx as any).skills;
      if (skillsSvc) {
        skillsList = await skillsSvc.list({ cwd: process.cwd() });
      }
    } catch (e) {}

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

    sections.forEach((sec: any) => {
      md += `### Section #${sec.index + 1}: \`${sec.name}\`
- **Length**: ${sec.charLength} chars (~${sec.estimatedTokens} tokens)

\`\`\`markdown
${sec.text}
\`\`\`

`;
    });

    md += `---

## 3. Dynamic Runtime Contexts (${contexts.length} contexts)

These are injected as \`user/form:snapshot\` messages by DSH when dynamic context updates:

`;

    contexts.forEach((c: any) => {
      md += `### Context: \`${c.name}\` (Order: ${c.order})
- **Length**: ${c.charLength} chars (~${c.estimatedTokens} tokens)

\`\`\`markdown
${c.text}
\`\`\`

`;
    });

    md += `---

## 4. Discovered Skills (${skillsList.length} skills)

Injected on step 1 by \`@deepseek-ai/dsh-tool-skill\` inside \`<available_skills>\`:

`;

    skillsList.forEach((s: any) => {
      md += `- **\`${s.name}\`**: ${s.description}\n`;
    });

    md += `

---

## 5. Tool Definitions Summary (${TOOLS.length} tools ~${toolDefsTokensEst} tokens)

| Tool Name | Parameters Schema Tokens (est) | Description |
|-----------|-------------------------------|-------------|
`;

    TOOLS.forEach((t: any) => {
      const fn = t.function || {};
      const schemaStr = JSON.stringify(fn.parameters || {});
      md += `| \`${fn.name}\` | ~${Math.round(schemaStr.length / 4)} | ${fn.description?.slice(0, 80) ?? ""}... |\n`;
    });

    const outPath = path.resolve(__dirname, "../../scratch/assembled-system-prompt.md");
    fs.writeFileSync(outPath, md, "utf-8");
    console.log(`Wrote inspection report to ${outPath}`);

    dispose?.();
  });
});
