import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../../lib/skills";
import { skillCatalog, skillTool } from "./skill";

function project() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "skill-"));
  const dir = path.join(cwd, ".claude", "skills", "release-notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: release-notes\ndescription: Draft release notes\n---\nList the merged PRs, newest first.\n");
  mkdirSync(path.join(dir, "templates")); writeFileSync(path.join(dir, "templates", "template.md"), "# Notes");
  return cwd;
}

function addSkill(cwd: string, name: string, description: string) {
  const dir = path.join(cwd, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`);
}

/** Only the temp project's skills, not the ones installed on this machine. */
const local = (cwd: string) => discoverSkills(cwd).filter((s) => s.filePath.startsWith(cwd));

describe("skill tool", () => {
  it("is absent when the project has no skills", () => {
    expect(skillTool({ cwd: mkdtempSync(path.join(os.tmpdir(), "noskill-")), discover: () => [] })).toBeUndefined();
  });

  it("keeps the list out of its description, lists on a call with no name, and loads a skill with its bundled files", async () => {
    const deps = { cwd: project(), discover: local };
    const tool = skillTool(deps)!;
    expect(tool.description).not.toContain("release-notes");
    const run = async (args: object) => JSON.stringify(await tool.execute(args as never, { callId: "c" } as never));
    expect(await run({})).toContain("release-notes: Draft release notes");
    const text = await run({ name: "release-notes" });
    expect(text).toContain("List the merged PRs");
    expect(text).toContain("template.md");
    expect(await run({ name: "nope" })).toContain("Unknown skill");
  });

  it("has the same definition whatever skills exist, and finds a skill added later", async () => {
    const deps = { cwd: project(), discover: local };
    const tool = skillTool(deps)!;
    const before = JSON.stringify([tool.description, tool.parameters]);
    addSkill(deps.cwd, "changelog", "Write the changelog entry. Long detail that the short list leaves out.");
    expect(JSON.stringify([skillTool(deps)!.description, skillTool(deps)!.parameters])).toBe(before);
    expect(JSON.stringify(await tool.execute({ name: "changelog" } as never, { callId: "c" } as never))).toContain("# Skill: changelog");
  });
});

describe("skillCatalog", () => {
  it("is undefined with no skills", () => {
    expect(skillCatalog({ cwd: "/", discover: () => [] })).toBeUndefined();
  });

  it("gives one clipped line per skill, sorted by name", () => {
    const cwd = project();
    addSkill(cwd, "changelog", "Write the changelog entry. Long detail that the short list leaves out.");
    addSkill(cwd, "audit", `${"word ".repeat(80)}end.`);
    const lines = skillCatalog({ cwd, discover: local })!.split("\n").slice(1);
    expect(lines.map((l) => l.split(":")[0])).toEqual(["- audit", "- changelog", "- release-notes"]);
    expect(lines[1]).toBe("- changelog: Write the changelog entry.");
    expect(lines[0].length).toBeLessThanOrEqual(170);
    expect(lines[0].endsWith("…")).toBe(true);
  });
});
