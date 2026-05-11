/**
 * skill — coding tool
 *
 * Loads the full body of a SKILL.md file on demand. The agent sees only
 * name+description in the system prompt (low token cost). When a skill is
 * relevant, the agent calls this tool to inject the full instructions.
 *
 * Compatible with the SKILL.md convention used by OpenCode, Cline, and
 * Claude Code — skills authored for those agents work here unchanged.
 */

import type { SkillMeta } from "../skills";
import { loadSkill } from "../skills";

export interface SkillArgs {
  /** Skill name (kebab-case, must match an entry in <available_skills>). */
  name: string;
}

export function makeSkillToolDefinition(skills: SkillMeta[]) {
  const names = skills.map((s) => s.name);
  const nameList = names.length > 0 ? names.join(", ") : "(none discovered)";

  return {
    type: "function" as const,
    function: {
      name: "skill",
      description:
        "Load the full instructions for a skill listed in <available_skills>. " +
        "Call this when a skill's description matches the current task. " +
        "The skill body will be injected into your context so you can follow its workflow. " +
        `Available skills: ${nameList}.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The skill name to load (must match a <name> in <available_skills>).",
          },
        },
        required: ["name"],
      },
    },
  };
}

export function skillTool(args: SkillArgs, skills: SkillMeta[]): string {
  const { name } = args;

  const content = loadSkill(name, skills);
  if (!content) {
    const available = skills.map((s) => s.name).join(", ");
    return JSON.stringify({
      error: `Skill "${name}" not found. Available skills: ${available || "none"}.`,
    });
  }

  const resourceSection =
    content.resources.length > 0
      ? `\n\n## Bundled resources\nThe following files are co-located with this skill and can be read with the \`read\` tool:\n${content.resources.map((r) => `- ${r} (full path: ${content.dirPath}/${r})`).join("\n")}`
      : "";

  return `## Skill: ${content.name}\n\n${content.body}${resourceSection}`;
}
