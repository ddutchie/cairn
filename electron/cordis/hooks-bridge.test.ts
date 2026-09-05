/**
 * hooks-bridge tests — adopt dsh-hook-protocol + both runners behind the
 * interception seams, DISABLED by default.
 *
 * Proves:
 *  - matcher/codec/merge behavior against fixtures (the wire contract the
 *    bridges run on);
 *  - config discovery: absent files → nothing configured (per dialect);
 *  - no-hooks-configured = zero behavior change (mountCairnHooks mounts no
 *    plugin, returns no disposers);
 *  - configured dialects mount with exactly { configPath } (upstream defaults
 *    for everything else).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Context } from "@deepseek-ai/cordis";
import {
  matcherDiagnostic,
  matchesMatcher,
  mergeHookOutputs,
  parseHookOutput,
} from "@deepseek-ai/dsh-hook-protocol";
import { resolveHooksConfig } from "./host-store";
import { mountCairnHooks } from "./hooks-bridge";

describe("hook-protocol matcher", () => {
  it("claude-code: match-all sentinels, literal alternation, regex fallback", () => {
    expect(matchesMatcher(undefined, "Bash", "claude-code")).toBe(true);
    expect(matchesMatcher("", "Bash", "claude-code")).toBe(true);
    expect(matchesMatcher("*", "Bash", "claude-code")).toBe(true);
    expect(matchesMatcher("Bash|Write", "Write", "claude-code")).toBe(true);
    expect(matchesMatcher("Bash|Write", "Read", "claude-code")).toBe(false);
    // Literal alternation is EXACT (no substring matching)…
    expect(matchesMatcher("Bash", "Bashful", "claude-code")).toBe(false);
    // …while non-literal patterns are unanchored regexes.
    expect(matchesMatcher("Bash.*", "Bashful", "claude-code")).toBe(true);
    expect(matchesMatcher("Write|Edit", "Write", "claude-code")).toBe(true);
  });
  it("codex: every non-empty pattern is an unanchored regex", () => {
    expect(matchesMatcher(undefined, "anything", "codex")).toBe(true);
    expect(matchesMatcher("tool", "my_tool_x", "codex")).toBe(true);
    expect(matchesMatcher("Write|Edit", "Write", "codex")).toBe(true); // regex alternation, also exact here
    expect(matchesMatcher("^Write$", "Write", "codex")).toBe(true);
    expect(matchesMatcher("^Write$", "WriteFile", "codex")).toBe(false);
  });
  it("invalid regexes never match and diagnose at config time", () => {
    expect(matchesMatcher("([", "([", "codex")).toBe(false);
    expect(matchesMatcher("([", "([", "claude-code")).toBe(false);
    expect(matcherDiagnostic("([", "codex")).toMatch(/invalid codex regex/);
    expect(matcherDiagnostic("([", "claude-code")).toMatch(/invalid claude-code regex/);
    expect(matcherDiagnostic("Bash|Write", "claude-code")).toBeUndefined();
    expect(matcherDiagnostic(undefined, "codex")).toBeUndefined();
  });
});

describe("hook-protocol codec", () => {
  it("exit 2 blocks with stderr as the reason", () => {
    const out = parseHookOutput(2, "", "do not touch prod\n");
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("do not touch prod");
  });
  it("exit 0 with legacy top-level approve decision", () => {
    const out = parseHookOutput(0, JSON.stringify({ decision: "approve" }), "");
    expect(out.decision).toBe("approve");
  });
  it("out-of-band top-level deny is invalid and ignored", () => {
    const out = parseHookOutput(0, JSON.stringify({ decision: "deny" }), "");
    expect(out.decision).toBeUndefined();
  });
  it("hookSpecificOutput permissionDecision overrides the top-level decision", () => {
    const out = parseHookOutput(
      0,
      JSON.stringify({
        decision: "approve",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "policy says no",
        },
      }),
      "",
      "PreToolUse",
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("policy says no");
    expect(out.hookEventName).toBe("PreToolUse");
  });
  it("mismatched hookEventName discards event-scoped fields but keeps the discriminator", () => {
    const out = parseHookOutput(
      0,
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          permissionDecision: "deny",
          additionalContext: "nope",
        },
      }),
      "",
      "PreToolUse",
    );
    expect(out.hookEventName).toBe("Stop");
    expect(out.decision).toBeUndefined();
    expect(out.additionalContext).toBeUndefined();
  });
  it("malformed JSON on a clean exit stays plain stdout (lenient, like the reference engines)", () => {
    const out = parseHookOutput(0, "{not json", "");
    expect(out.stdout).toBe("{not json");
    expect(out.decision).toBeUndefined();
  });
  it("plain stdout passes through with no decision", () => {
    const out = parseHookOutput(0, "just a note\n", "");
    expect(out.stdout).toBe("just a note");
    expect(out.decision).toBeUndefined();
  });
  it("continue:false + stopReason halt signal survives decoding", () => {
    const out = parseHookOutput(0, JSON.stringify({ continue: false, stopReason: "run tests first" }), "");
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe("run tests first");
  });
  it("non-blocking exits carry no decision", () => {
    expect(parseHookOutput(1, "oops", "trace").decision).toBeUndefined();
    expect(parseHookOutput(undefined, "", "spawn failed").decision).toBeUndefined();
  });
});

describe("hook-protocol merge", () => {
  it("empty match folds to the neutral element (the caller delegates — no behavior change)", () => {
    expect(mergeHookOutputs([])).toEqual({
      decision: "none",
      stop: false,
      additionalContext: [],
      systemMessages: [],
    });
  });
  it("deny > ask > allow; block/approve fold to deny/allow", () => {
    expect(mergeHookOutputs([{ exitCode: 0, stderr: "", stdout: "", decision: "allow" }]).decision).toBe("allow");
    expect(
      mergeHookOutputs([
        { exitCode: 0, stderr: "", stdout: "", decision: "allow" },
        { exitCode: 0, stderr: "", stdout: "", decision: "ask", reason: "sure?" },
      ]).decision,
    ).toBe("ask");
    expect(
      mergeHookOutputs([
        { exitCode: 0, stderr: "", stdout: "", decision: "ask", reason: "sure?" },
        { exitCode: 2, stderr: "", stdout: "", decision: "block", reason: "no" },
      ]).decision,
    ).toBe("deny");
    expect(mergeHookOutputs([{ exitCode: 0, stderr: "", stdout: "", decision: "approve" }]).decision).toBe("allow");
  });
  it("only the winning rank's reasons surface, joined; first stop sticks", () => {
    const merged = mergeHookOutputs([
      { exitCode: 0, stderr: "", stdout: "", decision: "ask", reason: "ask-r" },
      { exitCode: 2, stderr: "", stdout: "", decision: "block", reason: "deny-1" },
      { exitCode: 2, stderr: "", stdout: "", decision: "deny", reason: "deny-2" },
      { exitCode: 0, stderr: "", stdout: "", continue: false, stopReason: "first" },
      { exitCode: 0, stderr: "", stdout: "", continue: false, stopReason: "second" },
    ]);
    expect(merged.reason).toBe("deny-1\n\ndeny-2");
    expect(merged.stop).toBe(true);
    expect(merged.stopReason).toBe("first");
  });
  it("additionalContext and systemMessages accumulate in hook order", () => {
    const merged = mergeHookOutputs([
      { exitCode: 0, stderr: "", stdout: "", additionalContext: "ctx-a", systemMessage: "msg-a" },
      { exitCode: 0, stderr: "", stdout: "", additionalContext: "ctx-b" },
    ]);
    expect(merged.additionalContext).toEqual(["ctx-a", "ctx-b"]);
    expect(merged.systemMessages).toEqual(["msg-a"]);
  });
});

describe("hook config discovery (HostStore seam)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-hooks-home-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const hooksDir = (): string => path.join(home, ".config", "cairn", "hooks");

  it("absent files → nothing configured (hooks disabled by default)", () => {
    expect(resolveHooksConfig(home)).toEqual({});
  });
  it("each dialect resolves independently", () => {
    fs.mkdirSync(hooksDir(), { recursive: true });
    fs.writeFileSync(path.join(hooksDir(), "claude-code.json"), JSON.stringify({ hooks: {} }));
    const one = resolveHooksConfig(home);
    expect(one.claudeCode).toBe(path.join(hooksDir(), "claude-code.json"));
    expect(one.codex).toBeUndefined();
    fs.writeFileSync(path.join(hooksDir(), "codex.json"), JSON.stringify({ hooks: {} }));
    const both = resolveHooksConfig(home);
    expect(both.codex).toBe(path.join(hooksDir(), "codex.json"));
  });
  it("directories at the config path do not count", () => {
    fs.mkdirSync(path.join(hooksDir(), "claude-code.json"), { recursive: true });
    expect(resolveHooksConfig(home)).toEqual({});
  });
});

describe("mountCairnHooks wiring", () => {
  it("no-hooks-configured = zero behavior change (no plugin mounted, no disposers)", () => {
    const ctx = new Context();
    let plugged = 0;
    (ctx as unknown as { plugin: unknown }).plugin = (..._args: unknown[]): never => {
      plugged += 1;
      throw new Error("must not plug anything when no hooks are configured");
    };
    expect(mountCairnHooks(ctx, {})).toEqual([]);
    expect(plugged).toBe(0);
  });

  it("configured dialects mount with exactly { configPath }", () => {
    const ctx = new Context();
    const seen: Array<{ name: string; config: unknown }> = [];
    (ctx as unknown as { plugin: unknown }).plugin = ((plugin: { name: string }, config: unknown) => {
      seen.push({ name: plugin.name, config });
      return new Promise(() => {}); // pends like the real fiber (no shell on this ctx)
    }) as never;
    const disposers = mountCairnHooks(ctx, {
      claudeCode: "/hooks/claude-code.json",
      codex: "/hooks/codex.json",
    });
    expect(disposers).toHaveLength(2);
    expect(seen).toEqual([
      { name: "hooks-claude-code", config: { configPath: "/hooks/claude-code.json" } },
      { name: "hooks-codex", config: { configPath: "/hooks/codex.json" } },
    ]);
  });

  it("a single dialect mounts alone", () => {
    const ctx = new Context();
    const seen: string[] = [];
    (ctx as unknown as { plugin: unknown }).plugin = ((plugin: { name: string }) => {
      seen.push(plugin.name);
      return new Promise(() => {});
    }) as never;
    expect(mountCairnHooks(ctx, { codex: "/hooks/codex.json" })).toHaveLength(1);
    expect(seen).toEqual(["hooks-codex"]);
  });
});
