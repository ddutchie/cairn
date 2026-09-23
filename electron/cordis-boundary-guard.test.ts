import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ELECTRON_ROOT = path.resolve(__dirname);
const CORDIS_ROOT = path.join(ELECTRON_ROOT, "cordis");
const BLOCKED_MODULES = new Set(["cordis-context", "plan-fold", "session-stats", "session-export"]);

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
      || (importedModule === "run-cordis-loop" && (/\bgetContext\b/.test(bindings) || /(^|\s)\*/.test(bindings)));
    if (blocked) violations.push(`${relativePath}:${lineAt(source, match.index ?? 0)} imports ${importedModule}`);
  }

  for (const match of source.matchAll(dynamicImport)) {
    if (moduleName(match[2] ?? "") === "run-cordis-loop" && /\bgetContext\b/.test(match[1] ?? "")) {
      violations.push(`${relativePath}:${lineAt(source, match.index ?? 0)} imports getContext from run-cordis-loop`);
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
      "Route shared context, plan state, session stats, and session export through electron/cordis/agent-host.ts instead of importing Cordis internals outside electron/cordis.\n  Violations:\n    - " + violations.join("\n    - "),
    ).toEqual([]);
  });

  it("distinguishes getContext imports from supported run-cordis-loop helpers", () => {
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { getContext } from "../cordis/run-cordis-loop";')).toHaveLength(1);
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import { getSessionRoot } from "../cordis/run-cordis-loop";')).toEqual([]);
    expect(scanBoundaryViolations("electron/ipc/example.ts", 'import * as loop from "../cordis/run-cordis-loop";')).toHaveLength(1);
  });
});
