#!/usr/bin/env npx ts-node --project tsconfig.electron.json
/**
 * T33 — CI script: detect MCP / chat tool name drift
 *
 * Imports TOOL_DEFINITIONS from mcp-server.ts and TOOLS from tools.ts,
 * compares tool names, and exits non-zero if any shared tool is missing
 * from either side.
 *
 * Chat-only tools that intentionally do NOT exist in MCP are excluded.
 * Run: npx ts-node scripts/check-tool-parity.ts
 * Or add to package.json scripts: "check:tools": "ts-node scripts/check-tool-parity.ts"
 */

// Tools that exist in the AI chat loop but are intentionally absent from MCP.
// (They require LLM streaming, chat history, or AI generation.)
const CHAT_ONLY = new Set([
  "get_active_context",
  "generate_prd",
  "spawn_tasks_from_note",
]);

async function main() {
  // Dynamic imports to avoid circular compilation issues
  const { TOOLS } = await import("../electron/lib/tools");

  // We can't import mcp-server.ts directly (it has a top-level require.main check
  // and a DB connection). Instead we parse TOOL_DEFINITIONS by grepping the source.
  const fs = await import("fs");
  const path = await import("path");

  const mcpSource = fs.readFileSync(
    path.join(__dirname, "../electron/mcp-server.ts"),
    "utf-8"
  );

  // Extract tool names from TOOL_DEFINITIONS array — match: name: "tool_name"
  const mcpToolNames = new Set<string>();
  const nameRegex = /\{\s*name:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let inToolDefs = false;
  const lines = mcpSource.split("\n");
  for (const line of lines) {
    if (line.includes("const TOOL_DEFINITIONS")) inToolDefs = true;
    if (inToolDefs && line.includes("] as const")) break;
    if (inToolDefs) {
      const m = /name:\s*"([^"]+)"/.exec(line);
      if (m) mcpToolNames.add(m[1]);
    }
  }
  // Fallback: extract all name: "..." from the file if the above didn't work
  if (mcpToolNames.size === 0) {
    while ((match = nameRegex.exec(mcpSource)) !== null) {
      mcpToolNames.add(match[1]);
    }
  }

  const chatToolNames = new Set(TOOLS.map((t) => t.function.name));

  // Shared tools = chat tools that are NOT chat-only
  const sharedChatTools = [...chatToolNames].filter((n) => !CHAT_ONLY.has(n));

  let ok = true;

  // Check: every shared chat tool exists in MCP
  for (const name of sharedChatTools) {
    if (!mcpToolNames.has(name)) {
      console.error(`[drift] Chat tool "${name}" is MISSING from MCP TOOL_DEFINITIONS`);
      ok = false;
    }
  }

  // Check: every MCP tool exists in chat (it might be chat-only, which is fine)
  for (const name of mcpToolNames) {
    if (!chatToolNames.has(name)) {
      console.error(`[drift] MCP tool "${name}" is MISSING from chat TOOLS array`);
      ok = false;
    }
  }

  if (ok) {
    console.log(`[parity] OK — ${sharedChatTools.length} shared tools, ${CHAT_ONLY.size} chat-only tools, ${mcpToolNames.size} MCP tools`);
  } else {
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
