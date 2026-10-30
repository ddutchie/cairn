/** skill: load a SKILL.md playbook on demand. The catalog (name + description) is in the tool description. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { discoverSkills, loadSkill, type SkillMeta } from "../../lib/skills";
import { fail, ok } from "./schema";

export interface SkillDeps {
  cwd: string;
  /** Injectable for tests. */
  discover?: (cwd: string) => SkillMeta[];
}

export function skillTool({ cwd, discover = discoverSkills }: SkillDeps): AgentTool | undefined {
  let skills: SkillMeta[];
  try { skills = discover(cwd).filter((s) => !s.disableModelInvocation); } catch { return undefined; }
  if (!skills.length) return undefined;
  const catalog = skills.map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (${s.whenToUse})` : ""}`).join("\n");
  return defineTool({
    name: "skill",
    description: `Load the full instructions of a skill when the task matches it.\n\nAvailable skills:\n${catalog}`,
    parameters: Type.Object({ name: Type.String({ description: "Skill name from the list." }) }),
    risk: () => ({ class: "READ" }),
    async execute(a) {
      const skill = loadSkill(a.name, skills);
      if (!skill) return fail(`Unknown skill "${a.name}". Available: ${skills.map((s) => s.name).join(", ")}.`);
      const files = skill.resources.length ? `\n\nBundled files (relative to ${skill.dirPath}):\n${skill.resources.map((r) => `- ${r}`).join("\n")}` : "";
      return ok(`# Skill: ${skill.name}\nBase directory: ${skill.dirPath}\n\n${skill.body}${files}`);
    },
  });
}
