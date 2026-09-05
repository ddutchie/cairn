/**
 * cairn-skill-provider — bridges Cairn's SKILL.md loader onto dsh's SkillRegistry.
 *
 * The SkillRegistry (@deepseek-ai/dsh-skill) is the standard `skills` service on
 * the Cordis context: plugins inject it (dsh-visualize registers its bundled
 * skill provider via ctx.skills.registerProvider), and consumers read the merged
 * catalog via ctx.skills.list/get. This module adapts our engine-agnostic
 * SKILL.md discovery (electron/lib/skills.ts — .cairn/.opencode/.claude/…
 * project + global dirs) into a provider on that registry, so:
 *   - Cairn's skills and community-plugin skills share ONE catalog with dsh's
 *     rank/precedence semantics,
 *   - the `skill` tool and <available_skills> XML can migrate from reading the
 *     loader directly to reading ctx.skills (one seam for everything).
 *
 * Provider contract (dsh-skill): { name, list(options) → candidates[],
 * get(candidate, options) → definition | undefined }. Candidates carry rank
 * (lower wins duplicate names), invocation policy, an opaque locator, and an
 * optional resourceBase; definitions add `content`.
 */
import { BUNDLED_SKILL_RANK, type SkillProvider, type SkillCandidate, type SkillDefinition, type SkillLookupOptions } from "@deepseek-ai/dsh-skill";
import { discoverSkills as defaultDiscoverSkills, loadSkill as defaultLoadSkill } from "./host-store";
import type { SkillContent, SkillMeta } from "../lib/skills";

/** The provider we export — dsh's SkillProvider contract, exactly. */
export type CairnSkillProvider = SkillProvider;

export interface CairnSkillProviderDeps {
  /** Defaults to the host fs discovery (same behaviour; injectable for tests). */
  discoverSkills?: (cwd: string) => SkillMeta[];
  loadSkill?: (name: string, skills: SkillMeta[]) => SkillContent | null;
}

/**
 * Create the Cairn SKILL.md provider. Registered ONCE on the shared
 * SkillRegistry; the working directory comes from each call's view options
 * (`options.cwd` — the registry forwards the caller's cwd into list/get), so
 * per-turn cwd works without re-registering.
 */
export function createCairnSkillProvider(deps: CairnSkillProviderDeps = {}): CairnSkillProvider {
  const discoverSkills = deps.discoverSkills ?? defaultDiscoverSkills;
  const loadSkill = deps.loadSkill ?? defaultLoadSkill;
  const metas = (cwd?: string): SkillMeta[] => {
    if (!cwd) return [];
    try {
      return discoverSkills(cwd);
    } catch {
      return [];
    }
  };
  const PROVIDER = "cairn-skills";

  return {
     name: PROVIDER,
    async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      options.signal?.throwIfAborted();
      return metas(options.cwd).map(
        (m): SkillCandidate => ({
          name: m.name,
          description: m.description,
          invocation: { modelInvocable: !m.disableModelInvocation, userInvocable: !m.disableUserInvocation },
          source: "bundled",
          provider: PROVIDER,
          resourceBase: { kind: "directory", path: m.dirPath },
          // Standard packaged-provider rank: plugin providers may outrank or be
          // outranked by their own choice; ours sit at the bundled tier.
          rank: BUNDLED_SKILL_RANK,
          locator: m.filePath,
          ...(m.whenToUse ? { whenToUse: m.whenToUse } : {}),
        } as SkillCandidate),
      );
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      options.signal?.throwIfAborted();
      const ms = metas(options.cwd);
      const meta = ms.find((x) => x.name === candidate.name);
      const content = loadSkill(candidate.name, ms);
      if (!content) return undefined;
      return {
        name: content.name,
        description: content.description,
        invocation: { modelInvocable: !(meta?.disableModelInvocation), userInvocable: !(meta?.disableUserInvocation) },
        source: "bundled",
        provider: PROVIDER,
        resourceBase: { kind: "directory", path: content.dirPath },
        content: content.body,
        ...(meta?.whenToUse ? { whenToUse: meta.whenToUse } : {}),
      } as SkillDefinition;
    },
  };
}
