/**
 * skill-filesystem tests — dsh-skill-filesystem mounted as an ADDITIVE backend
 * behind the skill seam (`ctx.skills`), alongside Cairn's own provider.
 *
 * Proves:
 *  - discovered skills appear with the correct provider/source/rank
 *    (project .dsh rank 100 / project .agents rank 200 / user .dsh rank 400 /
 *    user .agents rank 500);
 *  - the existing Cairn provider behavior is unchanged (its roots still list
 *    under provider `cairn-skills`; dual-listed `.agents` names resolve to the
 *    dsh entry by the registry's lower-rank-wins rule — pinned + documented);
 *  - removal/unwatch cleans up (file deletion + invalidate drops the skill;
 *    unregistering the provider drops all of its skills while Cairn's remain;
 *    watcher disposal reaches quiescence).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Context } from "@deepseek-ai/cordis";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import {
  apply as skillFilesystemApply,
  inject as skillFilesystemInject,
  name as skillFilesystemName,
  FileSystemSkillProvider,
} from "@deepseek-ai/dsh-skill-filesystem";
import { createCairnSkillProvider } from "./cairn-skill-provider";

let projectDir: string;
let dshHome: string;
let agentsHome: string;

function writeSkillMd(root: string, name: string, description: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-dshfs-proj-"));
  dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-dshfs-dshhome-"));
  agentsHome = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-dshfs-aghome-"));
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  // dsh-only project root (.dsh is never scanned by Cairn's loader).
  writeSkillMd(path.join(projectDir, ".dsh", "skills"), "dshonly", "DSH-only skill.", "DSH-ONLY-BODY-9.");
  // Dual-listed root (.agents IS scanned by Cairn's loader too).
  writeSkillMd(path.join(projectDir, ".agents", "skills"), "shared", "Shared agents skill.", "SHARED-AGENTS-BODY-9.");
  // Cairn-only root (.cairn is never scanned by the dsh provider).
  writeSkillMd(path.join(projectDir, ".cairn", "skills"), "cairnonly", "Cairn-only skill.", "CAIRN-ONLY-BODY-9.");
  // User roots (isolated via explicit homes — never the real ~).
  writeSkillMd(path.join(dshHome, "skills"), "userskill", "User dsh skill.", "USER-DSH-BODY-9.");
  writeSkillMd(path.join(agentsHome, "skills"), "agskill", "User agents skill.", "USER-AGENTS-BODY-9.");
});

afterEach(() => {
  for (const dir of [projectDir, dshHome, agentsHome]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const DSH_CONFIG = (): Record<string, unknown> => ({
  providerName: "dsh-filesystem",
  includeDefaultRoots: true,
  dshHome,
  agentsHome,
  watch: false,
});

async function makeCtxWithBoth(): Promise<{ ctx: Context; fiber: Promise<{ dispose: () => unknown }> }> {
  const ctx = new Context();
  new SkillRegistry(ctx);
  const skills = ctx.skills as unknown as {
    registerProvider: (create: (control: never) => import("@deepseek-ai/dsh-skill").SkillProvider) => () => void;
  };
  skills.registerProvider(() => createCairnSkillProvider());
  const fiber = ctx.plugin(
    { apply: skillFilesystemApply, inject: skillFilesystemInject, name: skillFilesystemName } as never,
    DSH_CONFIG() as never,
  ) as unknown as Promise<{ dispose: () => unknown }>;
  await fiber;
  return { ctx, fiber };
}

describe("dsh-skill-filesystem as additive backend", () => {
  it("discovers project/user skills with correct provider + source", async () => {
    const { ctx, fiber } = await makeCtxWithBoth();
    try {
      const skills = ctx.skills as unknown as {
        list: (o: { cwd: string }) => Promise<Array<{ name: string; provider: string; source: string }>>;
        get: (n: string, o: { cwd: string }) => Promise<{ content: string; provider: string } | undefined>;
      };
      const summaries = await skills.list({ cwd: projectDir });
      const byName = new Map(summaries.map((s) => [s.name, s]));
      expect(byName.get("dshonly")).toMatchObject({ provider: "dsh-filesystem", source: "project-dsh" });
      expect(byName.get("userskill")).toMatchObject({ provider: "dsh-filesystem", source: "user-dsh" });
      expect(byName.get("agskill")).toMatchObject({ provider: "dsh-filesystem", source: "user-agents" });
      // Additive: Cairn's own root still serves under its own provider.
      expect(byName.get("cairnonly")).toMatchObject({ provider: "cairn-skills", source: "bundled" });
      // Bodies load through the winning provider.
      expect((await skills.get("dshonly", { cwd: projectDir }))?.content).toContain("DSH-ONLY-BODY-9.");
      expect((await skills.get("cairnonly", { cwd: projectDir }))?.content).toContain("CAIRN-ONLY-BODY-9.");
    } finally {
      await (await fiber).dispose();
    }
  });

  it("reports stable root ranks (project-dsh 100 < project-agents 200 < user 400/500 < bundled 600)", async () => {
    const ctx = new Context();
    new SkillRegistry(ctx);
    let captured: FileSystemSkillProvider | undefined;
    const skills = ctx.skills as unknown as {
      registerProvider: (create: (control: never) => import("@deepseek-ai/dsh-skill").SkillProvider) => () => void;
    };
    const disposer = skills.registerProvider((control) => {
      captured = new FileSystemSkillProvider(ctx, control as never, DSH_CONFIG() as never);
      return captured;
    });
    try {
      const candidates = (await captured!.list({ cwd: projectDir })) as Array<{ name: string; rank: number; source: string }>;
      const rankOf = (name: string): number => {
        const c = candidates.filter((x) => x.name === name).sort((a, b) => a.rank - b.rank)[0];
        if (!c) throw new Error(`missing candidate ${name}`);
        return c.rank;
      };
      expect(rankOf("dshonly")).toBe(100);
      expect(rankOf("shared")).toBe(200);
      expect(rankOf("userskill")).toBe(400);
      expect(rankOf("agskill")).toBe(500);
      // All dsh ranks outrank the bundled tier Cairn's provider uses (600).
      for (const c of candidates) expect(c.rank).toBeLessThan(600);
    } finally {
      disposer();
      await captured!.dispose();
    }
  });

  it("dual-listed .agents names resolve to the dsh entry (lower rank wins) with identical content", async () => {
    const { ctx, fiber } = await makeCtxWithBoth();
    try {
      const skills = ctx.skills as unknown as {
        get: (n: string, o: { cwd: string }) => Promise<{ content: string; provider: string } | undefined>;
      };
      // The .agents/shared file is accepted by BOTH parsers (same frontmatter
      // grammar); the registry's lower-rank-wins rule picks the dsh entry
      // (rank 200) over Cairn's (bundled rank 600). Same file, same body —
      // no user-visible content change.
      const def = await skills.get("shared", { cwd: projectDir });
      expect(def?.provider).toBe("dsh-filesystem");
      expect(def?.content).toContain("SHARED-AGENTS-BODY-9.");
    } finally {
      await (await fiber).dispose();
    }
  });

  it("file removal + invalidate drops the skill (the path watchers drive in production)", async () => {
    const ctx = new Context();
    new SkillRegistry(ctx);
    let capturedControl: { invalidate: () => void } | undefined;
    const skills = ctx.skills as unknown as {
      registerProvider: (create: (control: never) => import("@deepseek-ai/dsh-skill").SkillProvider) => () => void;
      list: (o: { cwd: string }) => Promise<Array<{ name: string }>>;
    };
    const disposer = skills.registerProvider((control) => {
      capturedControl = control as unknown as { invalidate: () => void };
      return new FileSystemSkillProvider(ctx, control as never, DSH_CONFIG() as never);
    });
    try {
      expect((await skills.list({ cwd: projectDir })).map((s) => s.name)).toContain("dshonly");
      fs.rmSync(path.join(projectDir, ".dsh", "skills", "dshonly"), { recursive: true, force: true });
      capturedControl!.invalidate();
      const names = (await skills.list({ cwd: projectDir })).map((s) => s.name);
      expect(names).not.toContain("dshonly");
      // Untouched skills survive the invalidation.
      expect(names).toContain("agskill");
    } finally {
      disposer();
    }
  });

  it("unregistering the provider drops its skills while Cairn's remain; watcher disposal is quiescent", async () => {
    const ctx = new Context();
    new SkillRegistry(ctx);
    const skills = ctx.skills as unknown as {
      registerProvider: (create: (control: never) => import("@deepseek-ai/dsh-skill").SkillProvider) => () => void;
      list: (o: { cwd: string }) => Promise<Array<{ name: string }>>;
    };
    skills.registerProvider(() => createCairnSkillProvider());
    let captured: FileSystemSkillProvider | undefined;
    const disposer = skills.registerProvider((control) => {
      // Watching ON here (unlike the tests above) to prove the watcher
      // lifecycle itself disposes cleanly; the fiber is torn down below.
      captured = new FileSystemSkillProvider(ctx, control as never, { ...DSH_CONFIG(), watch: true } as never);
      return captured;
    });
    try {
      const before = (await skills.list({ cwd: projectDir })).map((s) => s.name);
      expect(before).toContain("dshonly");
      expect(before).toContain("cairnonly");
    } finally {
      disposer();
    }
    await captured!.dispose();
    await captured!.dispose(); // idempotent
    const after = (await skills.list({ cwd: projectDir })).map((s) => s.name);
    expect(after).not.toContain("dshonly");
    expect(after).not.toContain("userskill");
    expect(after).toContain("cairnonly");
  });
});
