/**
 * skill: load a SKILL.md playbook on demand.
 *
 * The tool's own description is fixed. The list of skills is not in it: tool definitions sit at the
 * front of the request, so a list there re-writes the provider's cache for the whole conversation
 * whenever a skill file changes. A session instead gets the list once as context (`skillCatalog`),
 * and the tool returns it when called with no name.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { discoverSkills, loadSkill, type SkillMeta } from "../../lib/skills";
import { DEFAULT_CONTEXT_WINDOW } from "../provider";
import { fail, ok } from "./schema";

export interface SkillDeps {
  cwd: string;
  /** Injectable for tests. */
  discover?: (cwd: string) => SkillMeta[];
}

/** Share of the model's context window the skill list may take, the budget other harnesses use. */
const LIST_BUDGET_FRACTION = 0.02;
const CHARS_PER_TOKEN = 4;
/** A clipped description still has to say what the skill is for. */
const MIN_DESCRIPTION_CHARS = 80;

function modelSkills({ cwd, discover = discoverSkills }: SkillDeps): SkillMeta[] {
  try { return discover(cwd).filter((s) => !s.disableModelInvocation).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const describe = (s: SkillMeta) => `${s.description.trim()}${s.whenToUse ? ` (${s.whenToUse.trim()})` : ""}`.replace(/\s+/g, " ");

const fullCatalog = (skills: readonly SkillMeta[]) => skills.map((s) => `- ${s.name}: ${describe(s)}`).join("\n");

/**
 * The skill list a session is given once as model-only context. Descriptions are sent in full,
 * because they are what makes a skill trigger; only when the whole list is over its budget (2% of
 * the context window) is every description clipped to the same length. Undefined with no skills.
 */
export function skillCatalog(deps: SkillDeps & { contextWindow?: number }): string | undefined {
  const skills = modelSkills(deps);
  if (!skills.length) return undefined;
  const budget = Math.floor((deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW) * LIST_BUDGET_FRACTION * CHARS_PER_TOKEN);
  const full = fullCatalog(skills);
  if (full.length <= budget) return `Skills you can load with the skill tool:\n${full}`;
  const names = skills.reduce((n, s) => n + s.name.length + 5, 0);
  const each = Math.max(MIN_DESCRIPTION_CHARS, Math.floor((budget - names) / skills.length));
  const lines = skills.map((s) => `- ${s.name}: ${clip(describe(s), each)}`).join("\n");
  return `Skills you can load with the skill tool. Descriptions are shortened; call skill with no name for the full ones.\n${lines}`;
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
