import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectInstructions } from "./project-instructions";

const repo = () => { const d = mkdtempSync(path.join(os.tmpdir(), "instr-")); mkdirSync(path.join(d, ".git")); return d; };

describe("loadProjectInstructions", () => {
  it("returns nothing without files", () => expect(loadProjectInstructions(repo())).toBe(""));
  it("prefers AGENTS.md and resolves a CLAUDE.md that only imports it without duplicating", () => {
    const d = repo();
    writeFileSync(path.join(d, "AGENTS.md"), "use tabs");
    writeFileSync(path.join(d, "CLAUDE.md"), "@AGENTS.md");
    expect(loadProjectInstructions(d)).toBe("use tabs");
  });
  it("follows imports, and layers parent directories general-first", () => {
    const d = repo();
    writeFileSync(path.join(d, "CLAUDE.md"), "root\n@extra.md");
    writeFileSync(path.join(d, "extra.md"), "imported");
    mkdirSync(path.join(d, "pkg"));
    writeFileSync(path.join(d, "pkg", "AGENTS.md"), "pkg rule");
    const out = loadProjectInstructions(path.join(d, "pkg"));
    expect(out.indexOf("imported")).toBeGreaterThan(-1);
    expect(out.indexOf("root")).toBeLessThan(out.indexOf("pkg rule"));
  });
  it("ignores absolute imports and import cycles", () => {
    const d = repo();
    writeFileSync(path.join(d, "AGENTS.md"), "a\n@/etc/passwd\n@AGENTS.md");
    expect(loadProjectInstructions(d)).toContain("@/etc/passwd");
  });
});
