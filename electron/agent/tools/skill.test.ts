import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../../lib/skills";
import { skillTool } from "./skill";

function project() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "skill-"));
  const dir = path.join(cwd, ".claude", "skills", "release-notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: release-notes\ndescription: Draft release notes\n---\nList the merged PRs, newest first.\n");
  mkdirSync(path.join(dir, "templates")); writeFileSync(path.join(dir, "templates", "template.md"), "# Notes");
  return cwd;
}

describe("skill tool", () => {
  it("is absent when the project has no skills", () => {
    expect(skillTool({ cwd: mkdtempSync(path.join(os.tmpdir(), "noskill-")), discover: () => [] })).toBeUndefined();
  });

  it("lists skills in its description and loads one with its bundled files", async () => {
    const tool = skillTool({ cwd: project(), discover: (cwd) => discoverSkills(cwd).filter((s) => s.filePath.startsWith(cwd)) })!;
    expect(tool.description).toContain("release-notes: Draft release notes");
    const res = await tool.execute({ name: "release-notes" } as never, { callId: "c" } as never);
    const text = JSON.stringify(res);
    expect(text).toContain("List the merged PRs");
    expect(text).toContain("template.md");
    expect(JSON.stringify(await tool.execute({ name: "nope" } as never, { callId: "c" } as never))).toContain("Unknown skill");
  });
});
