/**
 * skill: load a SKILL.md playbook on demand.
 *
 * The tool's own description is fixed. The list of skills is not in it: tool definitions sit at the
 * front of the request, so a list there re-writes the provider's cache for the whole conversation
 * whenever a skill file changes, and is paid for on every request. A session instead gets a short
 * list once as context (`skillCatalog`), and the tool returns the full one when called with no name.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { discoverSkills, loadSkill, type SkillMeta } from "../../lib/skills";
import { fail, ok } from "./schema";

export interface SkillDeps {
  cwd: string;
  /** Injectable for tests. */
  discover?: (cwd: string) => SkillMeta[];
}

/** Longest description line in the short list; the full text is one `skill` call away. */
const SHORT_DESCRIPTION_CHARS = 160;

function modelSkills({ cwd, discover = discoverSkills }: SkillDeps): SkillMeta[] {
  try { return discover(cwd).filter((s) => !s.disableModelInvocation).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

function shortDescription(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > SHORT_DESCRIPTION_CHARS ? `${first.slice(0, SHORT_DESCRIPTION_CHARS - 1).trimEnd()}…` : first;
}

const fullCatalog = (skills: readonly SkillMeta[]) =>
  skills.map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (${s.whenToUse})` : ""}`).join("\n");

/**
 * The short skill list a session is given once as model-only context: one clipped line per skill.
 * Undefined when there are no skills the model may load.
 */
export function skillCatalog(deps: SkillDeps): string | undefined {
  const skills = modelSkills(deps);
  if (!skills.length) return undefined;
  const lines = skills.map((s) => `- ${s.name}: ${shortDescription(s.description)}`).join("\n");
  return `Skills you can load with the skill tool. Each line is a short summary; call skill with no name for the full descriptions.\n${lines}`;
}

export function skillTool(deps: SkillDeps): AgentTool | undefined {
  if (!modelSkills(deps).length) return undefined;
  return defineTool({
    name: "skill",
    description: "Load the full instructions of a skill when the task matches it. Call it with no name to list the skills with their full descriptions.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Skill name. Leave out to list the skills." })) }),
    risk: () => ({ class: "READ" }),
    async execute(a) {
      // Read at call time, so a skill added or edited during the session is found.
      const skills = modelSkills(deps);
      if (!a.name) return ok(skills.length ? `Available skills:\n${fullCatalog(skills)}` : "No skills are available.");
      const skill = loadSkill(a.name, skills);
      if (!skill) return fail(`Unknown skill "${a.name}". Available: ${skills.map((s) => s.name).join(", ")}.`);
      const files = skill.resources.length ? `\n\nBundled files (relative to ${skill.dirPath}):\n${skill.resources.map((r) => `- ${r}`).join("\n")}` : "";
      return ok(`# Skill: ${skill.name}\nBase directory: ${skill.dirPath}\n\n${skill.body}${files}`);
    },
  });
}
