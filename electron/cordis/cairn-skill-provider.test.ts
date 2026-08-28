/**
 * Unit tests for cairn-skill-provider: the bridge from Cairn's SKILL.md loader
 * onto dsh's SkillRegistry. Proves the provider shape AND the real registry
 * integration — registerProvider → list({cwd}) → get(name, {cwd}) — so the
 * merged-catalog seam plugins and our skill tool both use actually works.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Context } from "@deepseek-ai/cordis";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import { createCairnSkillProvider } from "./cairn-skill-provider";
import type { SkillCandidate } from "@deepseek-ai/dsh-skill";

// Our provider always returns a plain array (never the observation shorthand).
function asArray(listed: Awaited<ReturnType<ReturnType<typeof createCairnSkillProvider>["list"]>>): readonly SkillCandidate[] {
  return Array.isArray(listed) ? (listed as readonly SkillCandidate[]) : (listed as { candidates: readonly SkillCandidate[] }).candidates;
}

let cwd: string;

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = path.join(dir, ".cairn", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSay BANANA-PROTOCOL-7.\n`,
  );
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-skillprov-"));
  // A git-root marker stops the loader's walk-up so ancestor scanning can't
  // escape the temp dir (the global fallback dirs may still add the HOST's
  // skills — e.g. ~/.opencode/skills — so tests filter by name, not count).
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("createCairnSkillProvider", () => {
  it("lists discovered SKILL.md skills as dsh candidates (cwd from options)", async () => {
    writeSkill(cwd, "greeter", "Greeting protocol.");
    const provider = createCairnSkillProvider();
    expect(provider.name).toBe("cairn-skills");
    const listed = await provider.list({ cwd });
    const candidates = asArray(listed);
    const c = candidates.find((x) => x.name === "greeter");
    expect(c).toBeTruthy();
    expect(c!.description).toBe("Greeting protocol.");
    expect(c!.invocation).toEqual({ modelInvocable: true, userInvocable: true });
    expect(c!.rank).toBeGreaterThan(0);
    expect(String(c!.locator)).toContain("SKILL.md");
    expect((c!.resourceBase as { path?: string }).path).toContain(path.join(".cairn", "skills", "greeter"));
  });

  it("returns [] without a cwd, and never invents a local skill that doesn't exist", async () => {
    const provider = createCairnSkillProvider();
    expect(await provider.list({})).toEqual([]);
    const candidates = asArray(await provider.list({ cwd }));
    expect(candidates.find((x) => x.name === "greeter")).toBeUndefined();
  });

  it("get loads the body via the candidate name", async () => {
    writeSkill(cwd, "greeter", "Greeting protocol.");
    const provider = createCairnSkillProvider();
    const [candidate] = asArray(await provider.list({ cwd }));
    const def = await provider.get(candidate!, { cwd });
    expect(def).toBeTruthy();
    expect(def!.name).toBe("greeter");
    expect(def!.content).toContain("BANANA-PROTOCOL-7");
    // Unknown skill → undefined (registry treats it as absent).
    expect(await provider.get({ ...candidate!, name: "missing" }, { cwd })).toBeUndefined();
  });

  it("integrates with the real SkillRegistry: registerProvider → list/get through ctx.skills", async () => {
    writeSkill(cwd, "greeter", "Greeting protocol.");
    const ctx = new Context();
    new SkillRegistry(ctx); // mount the service like the Loader does
    const skills = (ctx as unknown as { skills: SkillRegistry }).skills;
    const disposer = skills.registerProvider(() => createCairnSkillProvider());
    try {
      const summaries = await skills.list({ cwd });
      expect(summaries.map((s) => s.name)).toContain("greeter");
      const def = await skills.get("greeter", { cwd });
      expect(def?.content).toContain("BANANA-PROTOCOL-7");
      // And an unknown name resolves to undefined rather than throwing.
      expect(await skills.get("nope", { cwd })).toBeUndefined();
    } finally {
      disposer();
    }
  });
});
