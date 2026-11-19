import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { validateToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CAN_SYMLINK } from "../../test-support/platform";
import { TOOL_SCHEMAS } from "../../lib/tool-schemas";
import type { AgentTool, ToolContext, ToolOutput } from "../tool-types";
import { bashTool } from "./bash";
import { cairnRisk, cairnTools } from "./cairn";
import { fsTools, riskPath } from "./fs";
import { buildToolset } from "./index";
import { todoTool } from "./todo";
import { htmlToText, isPrivateAddress } from "./web";

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ sessionId: "s", callId: "c", workspaceRoot: "/", ...extra });
const text = (o: ToolOutput) => (typeof o.content === "string" ? o.content : o.content.map((b) => (b.type === "text" ? b.text : "[img]")).join(""));
const get = (tools: AgentTool[], name: string) => tools.find((t) => t.name === name)!;
const run = (t: AgentTool, args: unknown, c = ctx()) => t.execute(args as never, c);

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-tools-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(path.join(dir, "notes.md"), "# hello\nneedle here\n");
  return dir;
}

describe("fs tools", () => {
  it.skipIf(!CAN_SYMLINK)("judges a call by where a symlink really leads", async () => {
    const dir = await workspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-outside-"));
    await mkdir(path.join(outside, ".ssh"));
    await writeFile(path.join(outside, ".ssh", "id_ed25519"), "key");
    await symlink(path.join(outside, ".ssh", "id_ed25519"), path.join(dir, "key-link"));
    await symlink(path.join(outside, ".ssh"), path.join(dir, "dir-link"));
    const real = await realpath(outside);
    expect(riskPath(dir, "key-link")).toBe(path.join(real, ".ssh", "id_ed25519"));
    // A file that does not exist yet, behind a linked folder.
    expect(riskPath(dir, "dir-link/authorized_keys")).toBe(path.join(real, ".ssh", "authorized_keys"));
    // Inside the working directory the path stays as given, even when the directory is itself reached through a link.
    expect(riskPath(dir, "src/a.ts")).toBe(path.join(dir, "src", "a.ts"));
    expect(riskPath(dir, "src/new.ts")).toBe(path.join(dir, "src", "new.ts"));
    const t = fsTools({ cwd: dir, rgPath });
    expect(get(t, "read").risk({ file_path: "key-link" } as never).paths).toEqual([path.join(real, ".ssh", "id_ed25519")]);
    expect(get(t, "write").risk({ file_path: "dir-link/authorized_keys", content: "" } as never).paths).toEqual([path.join(real, ".ssh", "authorized_keys")]);
  });

  it("reads with line numbers, offsets and a continuation hint", async () => {
    const dir = await workspace();
    const t = fsTools({ cwd: dir, rgPath });
    expect(text(await run(get(t, "read"), { file_path: "src/a.ts" }))).toContain("     1\texport const a = 1;");
    const part = text(await run(get(t, "read"), { file_path: "src/a.ts", offset: 2, limit: 1 }));
    expect(part).toContain("     2\texport const b = 2;");
    const first = text(await run(get(t, "read"), { file_path: "src/a.ts", limit: 1 }));
    expect(first).toContain("continue with offset 2");
  });

  it("requires a read before overwriting or editing, then allows it", async () => {
    const dir = await workspace();
    const t = fsTools({ cwd: dir, rgPath });
    const refused = await run(get(t, "edit"), { file_path: "notes.md", old_string: "hello", new_string: "bye" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/Read notes.md/);
    expect((await run(get(t, "write"), { file_path: "notes.md", content: "x" })).isError).toBe(true);
    await run(get(t, "read"), { file_path: "notes.md" });
    expect((await run(get(t, "edit"), { file_path: "notes.md", old_string: "hello", new_string: "bye" })).isError).toBeFalsy();
    expect(await readFile(path.join(dir, "notes.md"), "utf8")).toContain("# bye");
  });

  it("creates new files (and parent dirs) without a prior read", async () => {
    const dir = await workspace();
    const t = fsTools({ cwd: dir, rgPath });
    const out = await run(get(t, "write"), { file_path: "deep/new/f.txt", content: "hi" });
    expect(text(out)).toMatch(/Created/);
    expect(await readFile(path.join(dir, "deep/new/f.txt"), "utf8")).toBe("hi");
  });

  it("edit rejects ambiguous matches unless replace_all", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "d.txt"), "x x x");
    const t = fsTools({ cwd: dir, rgPath });
    await run(get(t, "read"), { file_path: "d.txt" });
    expect(text(await run(get(t, "edit"), { file_path: "d.txt", old_string: "x", new_string: "y" }))).toMatch(/3 times/);
    await run(get(t, "edit"), { file_path: "d.txt", old_string: "x", new_string: "y", replace_all: true });
    expect(await readFile(path.join(dir, "d.txt"), "utf8")).toBe("y y y");
  });

  it("globs and greps with ripgrep", async () => {
    const dir = await workspace();
    const t = fsTools({ cwd: dir, rgPath });
    expect(text(await run(get(t, "glob"), { pattern: "**/*.ts" }))).toBe(path.join("src", "a.ts"));
    expect(text(await run(get(t, "glob"), { pattern: "*.zzz" }))).toBe("No files matched");
    expect(text(await run(get(t, "grep"), { pattern: "needle" }))).toContain("needle here");
    expect(text(await run(get(t, "grep"), { pattern: "needle", output_mode: "files_with_matches" }))).toContain("notes.md");
    expect(text(await run(get(t, "grep"), { pattern: "nothing-here" }))).toBe("No matches");
  });

  it("classifies risk with absolute paths so the workspace rules can apply", async () => {
    const dir = await workspace();
    const t = fsTools({ cwd: dir, rgPath });
    expect(get(t, "write").risk({ file_path: "src/x.ts", content: "" })).toEqual({ class: "WRITE_LOCAL", paths: [path.join(dir, "src/x.ts")] });
    // Outside the working directory the real location is reported (`/etc` is a link on macOS; the node binary exists on every platform).
    expect(get(t, "read").risk({ file_path: process.execPath })).toEqual({ class: "READ", paths: [await realpath(process.execPath)] });
  });

  it("readOnly mode omits the mutating tools", () => {
    expect(fsTools({ cwd: "/", rgPath }, { readOnly: true }).map((t) => t.name).sort()).toEqual(["glob", "grep", "read", "read_image"]);
  });
});

describe("bash tool", () => {
  const bash = bashTool({ cwd: os.tmpdir() });
  it("returns output and marks nonzero exits as errors", async () => {
    expect(text(await run(bash, { command: "echo hi", description: "x" }))).toBe("hi");
    const bad = await run(bash, { command: "echo oops; exit 3", description: "x" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("[exit 3]");
  });
  it("kills on timeout and on abort", async () => {
    const slow = await run(bash, { command: "sleep 5", description: "x", timeoutMs: 100 });
    expect(text(slow)).toMatch(/timed out/);
    const ctl = new AbortController();
    const p = run(bash, { command: "sleep 5", description: "x" }, ctx({ signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 50);
    expect(text(await p)).toMatch(/aborted/);
  });
  it("reports the command to the policy pipeline", () => {
    expect(bash.risk({ command: "git status", description: "x" })).toMatchObject({ class: "EXEC", command: "git status" });
  });
});

describe("web helpers", () => {
  it("flags private and loopback addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:1", "64:ff9b::7f00:1", "224.0.0.1", "198.18.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("strips markup", () => {
    expect(htmlToText("<html><head><title>t</title></head><body><script>x()</script><p>Hello &amp; bye</p><ul><li>one</li></ul></body></html>")).toBe("Hello & bye\n- one");
  });
});

describe("todo tool", () => {
  it("reports the list to the callback", async () => {
    let seen = 0;
    const out = await run(todoTool((t) => { seen = t.length; }), { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] });
    expect(seen).toBe(2);
    expect(text(out)).toContain("1/2");
  });
});

describe("cairn tools", () => {
  const deps = { getDb: () => { throw new Error("no db"); }, req: {} as never, workspacePath: "/", llmConfig: {} as never };
  const tools = cairnTools(deps);

  it("exposes every TOOL_SCHEMAS entry, minus exclusions (People only when on)", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_SCHEMAS).filter((n) => n !== "people").sort());
    expect(cairnTools({ ...deps, people: true }).map((t) => t.name).sort()).toEqual(Object.keys(TOOL_SCHEMAS).sort());
    expect(cairnTools(deps, { exclude: new Set(["delete"]) }).some((t) => t.name === "delete")).toBe(false);
  });

  it("classifies reads, Cairn writes and the ask-by-default delete", () => {
    expect(cairnRisk("get_item").class).toBe("READ");
    expect(cairnRisk("edit_note").class).toBe("WRITE_CAIRN");
    expect(cairnRisk("create_task").class).toBe("WRITE_CAIRN");
    expect(cairnRisk("delete").class).toBe("WRITE_LOCAL");
  });

  it("produces schemas pi-ai can validate calls against", () => {
    const getItem = get(tools, "get_item");
    expect(validateToolCall([getItem], { type: "toolCall", id: "1", name: "get_item", arguments: { id: "n_1" } })).toEqual({ id: "n_1" });
    expect(() => validateToolCall([getItem], { type: "toolCall", id: "1", name: "get_item", arguments: {} })).toThrow();
  });

  it("ask_questions uses the blocking seam when provided", async () => {
    const t = cairnTools({ ...deps, askQuestions: async () => [{ id: "q", custom: "yes" }] });
    const out = await run(get(t, "ask_questions"), { questions: [{ id: "q", question: "?" }] });
    expect(text(out)).toContain('"answers":[{"id":"q","custom":"yes"}]');
  });
});

describe("buildToolset", () => {
  const cairn = { getDb: () => { throw new Error("no db"); }, req: {} as never, workspacePath: "/", llmConfig: {} as never };
  const fs = { cwd: "/", rgPath };
  it("gives each surface its stack", async () => {
    const chat = (await buildToolset({ surface: "chat", cairn, fs })).map((t) => t.name);
    expect(chat).toContain("get_context");
    expect(chat).not.toContain("bash");
    expect(chat).not.toContain("read");
    const coding = (await buildToolset({ surface: "coding", cairn, fs })).map((t) => t.name);
    expect(coding).toEqual(expect.arrayContaining(["get_context", "read", "write", "edit", "glob", "grep", "bash", "web_fetch", "todo_write"]));
    const auto = (await buildToolset({ surface: "automation-dev", cairn, fs })).map((t) => t.name);
    expect(auto).toContain("edit");
    expect(auto).not.toContain("bash");
  });
});

describe("tools through the loop", () => {
  it("workspace-edits allows writes under the workspace and asks for ones outside it", async () => {
    const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const { runTurn } = await import("../loop");
    const { drive, makeHarness, ofType } = await import("../test-harness");
    const { presetRules } = await import("../rules");
    const dir = await workspace();
    const h = makeHarness({ tools: fsTools({ cwd: dir, rgPath }), rules: presetRules("workspace-edits") });
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { file_path: "inside.txt", content: "a" }, { id: "w1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write", { file_path: "/tmp/agent-outside.txt", content: "b" }, { id: "w2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const events = await drive(runTurn(h.opts({ workspaceRoot: dir })), (ev) => {
      if (ev.type === "approval/asked") h.gate.resolve(ev.ask.sessionId, ev.ask.callId, ev.ask.nonce, { approved: false });
    });
    expect(ofType(events, "approval/asked").map((e) => e.ask.callId)).toEqual(["w2"]);
    expect(await readFile(path.join(dir, "inside.txt"), "utf8")).toBe("a");
  });
});

describe("exit_plan_mode", () => {
  it("hands the plan over and tells the model to wait", async () => {
    const { planTools } = await import("./plan");
    const plans: Array<[string, string]> = [];
    const [tool] = planTools({ onPlan: (sid, plan) => plans.push([sid, plan]) });
    expect(tool.risk({ plan: "x" })).toEqual({ class: "READ" });
    const out = await tool.execute({ plan: "## Tasks\n- [ ] a" }, { sessionId: "s1", callId: "c1", workspaceRoot: "/ws" });
    expect(plans).toEqual([["s1", "## Tasks\n- [ ] a"]]);
    expect(out.isError).toBeFalsy();
    const empty = await tool.execute({ plan: "  " }, { sessionId: "s1", callId: "c2", workspaceRoot: "/ws" });
    expect(empty.isError).toBe(true);
    expect(plans).toHaveLength(1);
  });

  it("stays registered outside plan mode but refuses to submit a plan", async () => {
    const { planTools } = await import("./plan");
    const plans: string[] = [];
    const [tool] = planTools({ active: () => false, onPlan: (_sid, plan) => plans.push(plan) });
    const out = await tool.execute({ plan: "## Tasks" }, { sessionId: "s1", callId: "c1", workspaceRoot: "/ws" });
    expect(out.isError).toBe(true);
    expect(plans).toEqual([]);
  });
});
