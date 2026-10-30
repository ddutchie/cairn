import { describe, expect, it } from "vitest";
import { callSignature, decide, type Mode, type PolicyState } from "./policy";
import { PRESETS, presetRules, type CallView, type Rule } from "./rules";

const base = (over: Partial<PolicyState> = {}): PolicyState => ({
  mode: "ask", deniedTools: [], rules: [], workspaceRoot: "/ws", recent: [], doomAcked: new Set(), ...over,
});
const rule = (r: Partial<Rule> & Pick<Rule, "effect" | "match">): Rule => ({ id: "r", scope: "session", source: "user", ...r });
const decideFor = (call: CallView, state: PolicyState, args: unknown = {}) => decide(call, callSignature(call.name, args), state);

const read: CallView = { name: "read", risk: { class: "READ" } };
const note: CallView = { name: "note_write", risk: { class: "WRITE_CAIRN" } };
const edit = (p: string): CallView => ({ name: "write", risk: { class: "WRITE_LOCAL", paths: [p] } });
const bash = (command: string): CallView => ({ name: "bash", risk: { class: "EXEC", command } });

describe("decide: defaults by mode", () => {
  it("allows READ in every mode", () => {
    for (const mode of ["ask", "auto", "yolo", "plan"] as Mode[]) expect(decideFor(read, base({ mode })).kind).toBe("allow");
  });

  it.each([
    ["ask", "ask"], ["auto", "review"], ["yolo", "allow"],
  ] as const)("unresolved write in %s mode → %s", (mode, kind) => {
    expect(decideFor(bash("make"), base({ mode })).kind).toBe(kind);
  });
});

describe("decide: Cairn writes", () => {
  it("are asked without the preset and allowed with it", () => {
    expect(decideFor(note, base()).kind).toBe("ask");
    const d = decideFor(note, base({ rules: presetRules("cairn-data") }));
    expect(d).toMatchObject({ kind: "allow", by: "rule" });
  });
});

describe("decide: profile and plan mode", () => {
  it("denies tools the profile does not have, even with an allow rule", () => {
    const d = decideFor(bash("ls"), base({ deniedTools: ["bash"], rules: [rule({ effect: "allow", match: { tool: "bash" } })] }));
    expect(d).toMatchObject({ kind: "deny", by: "profile" });
  });

  it("enforces read-only in plan mode and cannot be overridden by a rule or yolo", () => {
    const allow = rule({ effect: "allow", match: { tool: "write" } });
    expect(decideFor(edit("a.ts"), base({ mode: "plan", rules: [allow] }))).toMatchObject({ kind: "deny", by: "plan" });
    expect(decideFor(note, base({ mode: "plan", rules: presetRules("cairn-data") }))).toMatchObject({ kind: "deny", by: "plan" });
  });
});

describe("decide: rules", () => {
  it("deny beats allow", () => {
    const rules = [rule({ id: "a", effect: "allow", match: { tool: "bash" } }), rule({ id: "d", effect: "deny", match: { command: { prefix: ["rm"] } } })];
    expect(decideFor(bash("rm -rf build"), base({ rules }))).toMatchObject({ kind: "deny", ruleId: "d" });
  });

  it("an ask rule keeps asking in yolo mode and is never reviewed in auto mode", () => {
    const rules = [rule({ effect: "ask", match: { tool: "bash" } })];
    expect(decideFor(bash("ls"), base({ mode: "yolo", rules })).kind).toBe("ask");
    expect(decideFor(bash("ls"), base({ mode: "auto", rules })).kind).toBe("ask");
  });

  it("ask beats allow", () => {
    const rules = [rule({ effect: "allow", match: { tool: "bash" } }), rule({ effect: "ask", match: { tool: "bash" } })];
    expect(decideFor(bash("ls"), base({ rules })).kind).toBe("ask");
  });

  it("workspace-edits preset allows in-workspace edits only", () => {
    const state = base({ rules: presetRules("workspace-edits") });
    expect(decideFor(edit("src/a.ts"), state).kind).toBe("allow");
    expect(decideFor(edit("../a.ts"), state).kind).toBe("ask");
    expect(decideFor(edit("/etc/hosts"), state).kind).toBe("ask");
  });

  it("read-only preset denies writes", () => {
    expect(decideFor(edit("a.ts"), base({ rules: PRESETS["read-only"] })).kind).toBe("deny");
  });
});

describe("decide: protected paths", () => {
  const workspaceEdits = presetRules("workspace-edits");

  it("a preset never allows a protected path", () => {
    expect(decideFor(edit(".env"), base({ rules: workspaceEdits }))).toMatchObject({ kind: "ask", by: "protected" });
    expect(decideFor(edit(".git/hooks/pre-commit"), base({ rules: workspaceEdits }))).toMatchObject({ kind: "ask", by: "protected" });
  });

  it("asks in yolo mode too", () => {
    expect(decideFor(edit(".env"), base({ mode: "yolo" })).kind).toBe("ask");
  });

  it("an explicit user or grant rule can allow it", () => {
    const rules = [...workspaceEdits, rule({ id: "u", effect: "allow", match: { tool: "write" } })];
    expect(decideFor(edit(".env"), base({ rules }))).toMatchObject({ kind: "allow", ruleId: "u" });
  });

  it("does not apply to reads", () => {
    const readEnv: CallView = { name: "read", risk: { class: "READ", paths: [".env"] } };
    expect(decideFor(readEnv, base()).kind).toBe("allow");
  });
});

describe("decide: doom loop", () => {
  const call = bash("make");
  const sig = callSignature("bash", { command: "make" });
  const allowAll = [rule({ effect: "allow", match: { tool: "bash" } })];

  it("asks on the third identical call even when a rule allows it", () => {
    expect(decide(call, sig, base({ rules: allowAll, recent: [sig] })).kind).toBe("allow");
    expect(decide(call, sig, base({ rules: allowAll, recent: [sig, sig] }))).toMatchObject({ kind: "ask", by: "doom" });
  });

  it("asks (not reviews) in auto mode and in yolo mode", () => {
    expect(decide(call, sig, base({ mode: "auto", recent: [sig, sig] })).kind).toBe("ask");
    expect(decide(call, sig, base({ mode: "yolo", recent: [sig, sig] })).kind).toBe("ask");
  });

  it("only counts a trailing run", () => {
    expect(decide(call, sig, base({ rules: allowAll, recent: [sig, "other", sig] })).kind).toBe("allow");
  });

  it("stops asking once a human acknowledged it", () => {
    expect(decide(call, sig, base({ rules: allowAll, recent: [sig, sig], doomAcked: new Set([sig]) })).kind).toBe("allow");
  });

  it("a deny rule still wins over the pause", () => {
    const rules = [rule({ effect: "deny", match: { tool: "bash" } })];
    expect(decide(call, sig, base({ rules, recent: [sig, sig] })).kind).toBe("deny");
  });
});

describe("callSignature", () => {
  it("is independent of key order", () => {
    expect(callSignature("t", { a: 1, b: { c: 2, d: 3 } })).toBe(callSignature("t", { b: { d: 3, c: 2 }, a: 1 }));
  });
});
