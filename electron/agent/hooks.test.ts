import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHooks, parseHookConfig, type HookConfig } from "./hooks";
import { drive, makeHarness, makeTools, ofType, toolResults, types } from "./test-harness";
import { runTurn } from "./loop";

const cwd = mkdtempSync(path.join(os.tmpdir(), "hooks-"));
const config = (hooks: Record<string, unknown>): HookConfig => parseHookConfig(JSON.stringify({ hooks }), cwd);
const cmd = (command: string, matcher?: string) => [{ matcher, hooks: [{ type: "command", command }] }];
const hooksFor = (hooks: Record<string, unknown>) => createHooks({ sessionId: "s1", cwd, configs: [config(hooks)] })!;

describe("parseHookConfig", () => {
  it("reads a settings file's hooks key and a bare hooks map, skipping bad matchers and non-command hooks", () => {
    const hooks = { PreToolUse: [{ matcher: "(", hooks: [{ command: "x" }] }, { matcher: "Bash|write.*", hooks: [{ type: "http", url: "u" }, { type: "command", command: "ok", timeout: 5 }] }], Unknown: [] };
    for (const doc of [{ hooks }, hooks]) {
      const parsed = parseHookConfig(JSON.stringify(doc), cwd);
      expect(parsed.PreToolUse).toHaveLength(1);
      expect(parsed.PreToolUse![0].hooks).toEqual([{ command: "ok", timeoutMs: 5000 }]);
      expect(parsed.PreToolUse![0].matcher!.test("write_file")).toBe(true);
    }
  });
  it("returns nothing for unreadable config", () => {
    expect(parseHookConfig("not json", cwd)).toEqual({});
    expect(createHooks({ sessionId: "s", cwd, configs: [{}] })).toBeUndefined();
  });
});

describe("hook commands", () => {
  it("exit code 2 blocks a tool with the stderr reason; matchers filter by tool name", async () => {
    const h = hooksFor({ PreToolUse: cmd("echo no rm here >&2; exit 2", "bash") });
    expect(await h.preTool!({ name: "bash", args: { command: "rm" }, callId: "c" })).toEqual({ decision: "deny", reason: "no rm here" });
    expect(await h.preTool!({ name: "read", args: {}, callId: "c" })).toEqual({});
  });
  it("reads permissionDecision and additionalContext from JSON output, and sends the event on stdin", async () => {
    const h = hooksFor({
      PreToolUse: cmd(`echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"check it"}}'`),
      UserPromptSubmit: cmd(`cat > "${cwd}/stdin.json"; echo '{"additionalContext":"today is Friday"}'`),
    });
    expect(await h.preTool!({ name: "bash", args: {}, callId: "c" })).toEqual({ decision: "ask", reason: "check it" });
    expect(await h.userPrompt!("hello")).toEqual({ context: "today is Friday" });
    expect(JSON.parse(readFileSync(path.join(cwd, "stdin.json"), "utf8"))).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "hello", session_id: "s1" });
  });
  it("ignores a hook that crashes with another exit code", async () => {
    expect(await hooksFor({ Stop: cmd("exit 1") }).stop!()).toEqual({});
  });
});

describe("hooks in the loop", () => {
  const run = (hooks: Record<string, unknown>, responses: Parameters<ReturnType<typeof makeHarness>["faux"]["setResponses"]>[0], mode: "ask" | "yolo" = "yolo") => {
    const executed: Array<{ name: string; args: unknown }> = [];
    const h = makeHarness({ profile: { mode } });
    h.faux.setResponses(responses);
    return { h, executed, events: drive(runTurn({ ...h.opts(), tools: makeTools(executed), hooks: hooksFor(hooks) })) };
  };
  const call = (name: string, args: Record<string, unknown>) => fauxToolCall(name, args as never, { id: "c1" });

  it("a PreToolUse deny stops the tool from running and tells the model", async () => {
    const t = run({ PreToolUse: cmd("echo blocked by policy >&2; exit 2") }, [fauxAssistantMessage([call("echo", { text: "a" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const events = await t.events;
    expect(t.executed).toHaveLength(0);
    expect(ofType(events, "tool/result")[0]).toMatchObject({ isError: true });
    expect(ofType(events, "tool/result")[0].text).toContain("blocked by policy");
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: false, by: "hook" });
  });

  it("a PreToolUse ask upgrades an allowed call to an approval", async () => {
    const t = run({ PreToolUse: cmd(`echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`) }, [fauxAssistantMessage([call("echo", { text: "a" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const events: string[] = [];
    const gen = (async () => { for (const e of await t.events) events.push(e.type); })();
    await gen.catch(() => undefined);
    expect(events).toContain("approval/asked");
  });

  it("PostToolUse context is appended to the result; a block replaces it", async () => {
    const withContext = run({ PostToolUse: cmd(`echo '{"additionalContext":"remember the lint rules"}'`) }, [fauxAssistantMessage([call("echo", { text: "a" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    expect(ofType(await withContext.events, "tool/result")[0].text).toContain("remember the lint rules");
    const blocked = run({ PostToolUse: cmd("echo leaked a secret >&2; exit 2") }, [fauxAssistantMessage([call("echo", { text: "a" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok")]);
    const result = ofType(await blocked.events, "tool/result")[0];
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("leaked a secret");
  });

  it("a blocked prompt ends the turn without calling the model", async () => {
    const t = run({ UserPromptSubmit: cmd("echo off limits >&2; exit 2") }, [fauxAssistantMessage("never")]);
    const events = await t.events;
    expect(types(events)).toEqual(["turn/start", "user/message", "error", "turn/end"]);
    expect(toolResults(t.h.history)).toHaveLength(0);
  });

  it("a Stop hook sends the model back to work, a limited number of times", async () => {
    const t = run({ Stop: cmd(`echo tests are failing >&2; exit 2`) }, [fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three"), fauxAssistantMessage("four"), fauxAssistantMessage("five")]);
    const events = await t.events;
    expect(ofType(events, "assistant/message")).toHaveLength(4);
    expect(t.h.history.some((m) => m.role === "user" && JSON.stringify(m.content).includes("continue: tests are failing"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn/end", reason: "stop" });
  });
});
