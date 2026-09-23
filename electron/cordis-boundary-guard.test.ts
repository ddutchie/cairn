import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ELECTRON_ROOT = path.resolve(__dirname);
const CORDIS_ROOT = path.join(ELECTRON_ROOT, "cordis");
// Stateful engine modules: all access from outside electron/cordis/ must go
// through electron/cordis/agent-host.ts. Pure helpers are NOT listed here and
// stay directly importable: withToolCallView/withToolResultView,
// normalizeSubagentScope, canonicalBashCommand (via run-cordis-loop /
// subagent-control / approval-grants respectively), and the main-side plugin
// file surface (plugin-loader: plugins.yml YAML + fs watcher stay in main).
const BLOCKED_MODULES = new Set([
  "cordis-context",
  "plan-fold",
  "session-stats",
  "session-export",
  "approval-runtime",
  "approval-grants",
  "secret-grants",
  "pending-question-broker",
  "turn-runtime",
  "approval-transports",
  "jobs-bridge",
]);
// run-cordis-loop re-exports both blocked state (getContext) and allowed
// pure/config helpers (getSessionRoot, withToolCallView, withToolResultView).
// dropChatAgentForThread is engine-owned agent-cache state → blocked.
const BLOCKED_LOOP_BINDINGS = new Set(["getContext", "dropChatAgentForThread"]);

function moduleName(specifier: string): string | undefined {
  const normalized = specifier.replace(/\\/g, "/").replace(/\.[cm]?[jt]sx?$/, "");
  return normalized.match(/(?:^|\/)cordis\/([^/]+)$/)?.[1];
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function scanBoundaryViolations(relativePath: string, source: string): string[] {
  const violations: string[] = [];
  const staticImport = /\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  const dynamicImport = /\bconst\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;
  const requireCall = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(staticImport)) {
    const bindings = match[1] ?? "";
    const importedModule = moduleName(match[2] ?? "");
    if (!importedModule) continue;
    const blocked = BLOCKED_MODULES.has(importedModule)
      || (importedModule === "run-cordis-loop" && ([...BLOCKED_LOOP_BINDINGS].some((name) => new RegExp(`\\b${name}\\b`).test(bindings)) || /(^|\s)\*/.test(bindings)));
    if (blocked) violations.push(`${relativePath}:${lineAt(source, match.index ?? 0)} imports ${importedModule}`);
  }

  for (const match of source.matchAll(dynamicImport)) {
    if (moduleName(match[2] ?? "") === "run-cordis-loop" && [...BLOCKED_LOOP_BINDINGS].some((name) => new RegExp(`\\b${name}\\b`).test(match[1] ?? ""))) {
      violations.push(`${relativePath}:${lineAt(source, match.index ?? 0)} imports ${[...BLOCKED_LOOP_BINDINGS].filter((name) => new RegExp(`\\b${name}\\b`).test(match[1] ?? "")).join("/")} from run-cordis-loop`);
    }
  }

  for (const match of source.matchAll(requireCall)) {
    const importedModule = moduleName(match[1] ?? "");
    if (importedModule && (BLOCKED_MODULES.has(importedModule) || importedModule === "run-cordis-loop")) {
      violations.push(`${relativePath}:${lineAt(source, match.index ?? 0)} requires ${importedModule}`);
    }
  }

  return violations;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (absolute !== CORDIS_ROOT) files.push(...sourceFiles(absolute));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(absolute);
  }
  return files;
}

describe("Cordis host boundary", () => {
  it("keeps direct context and internal state access inside electron/cordis", () => {
    const violations = sourceFiles(ELECTRON_ROOT).flatMap((file) => {
      const relativePath = path.relative(path.resolve(ELECTRON_ROOT, ".."), file);
      return scanBoundaryViolations(relativePath, fs.readFileSync(file, "utf8"));
    });

    expect(
      violations,
      "Route shared context, plan state, session stats, session export, approval/question/turn/transport/job state through electron/cordis/agent-host.ts instead of importing Cordis internals outside electron/cordis.\n  Violations:\n    - " + violations.join("\n    - "),
    ).toEqual([]);
  });

  it("distinguishes blocked run-cordis-loop bindings from supported helpers", () => {
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { getContext } from "../cordis/run-cordis-loop";')).toHaveLength(1);
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { dropChatAgentForThread } from "../cordis/run-cordis-loop";')).toHaveLength(1);
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { getSessionRoot } from "../cordis/run-cordis-loop";')).toEqual([]);
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { withToolCallView } from "../cordis/run-cordis-loop";')).toEqual([]);
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import * as loop from "../cordis/run-cordis-loop";')).toHaveLength(1);
  });

  it("blocks stateful engine modules outside electron/cordis", () => {
    for (const mod of ["approval-runtime", "approval-grants", "secret-grants", "pending-question-broker", "turn-runtime", "approval-transports", "jobs-bridge"]) {
      expect(scanBoundaryViolations("electron/ipc/example.ts", `import { something } from "../cordis/${mod}";`)).toHaveLength(1);
    }
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { normalizeSubagentScope } from "../cordis/subagent-control";')).toEqual([]);
  });
});
