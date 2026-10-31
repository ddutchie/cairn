import { describe, expect, it } from "vitest";
import { stripControl, TerminalRegistry, type PtyAdapter } from "./terminals";
import { terminalTools } from "./tools/terminal";

/** A shell that answers `echo x` with `x` and exits on `exit`. */
function fakePty() {
  const data = new Map<string, (d: string) => void>();
  const exits = new Map<string, (e: { exitCode: number }) => void>();
  const log: string[] = [];
  let n = 0;
  const adapter: PtyAdapter = {
    spawn: async () => { const id = `p${++n}`; setTimeout(() => data.get(id)?.("\x1b[32m$ \x1b[0m"), 5); return { sessionId: id }; },
    write: (id, input) => {
      log.push(input);
      const line = input.trim();
      if (line === "exit") setTimeout(() => exits.get(id)?.({ exitCode: 0 }), 5);
      else if (line.startsWith("echo ")) setTimeout(() => data.get(id)?.(`${line.slice(5)}\r\n$ `), 5);
    },
    signal: (id, sig) => { log.push(`signal:${sig}`); },
    kill: (id) => { log.push(`kill:${id}`); },
    onData: (id, cb) => { data.set(id, cb); return () => data.delete(id); },
    onExit: (id, cb) => { exits.set(id, cb); return () => exits.delete(id); },
  };
  return { adapter, log };
}

describe("stripControl", () => {
  it("removes colours and carriage returns and holds back a cut-off escape sequence", () => {
    expect(stripControl("\x1b[31mred\x1b[0m\r\nok")).toEqual({ text: "red\nok", pending: "" });
    expect(stripControl("abc\x1b[3")).toEqual({ text: "abc", pending: "\x1b[3" });
  });
});

describe("TerminalRegistry", () => {
  it("keeps one shell across sends and returns only new output", async () => {
    const { adapter } = fakePty();
    const reg = new TerminalRegistry(() => adapter);
    const t = await reg.open("s1", "/ws");
    const a = await reg.send("s1", t.id, "echo one\n", { idleMs: 30 });
    expect(a.text).toContain("one");
    const b = await reg.send("s1", t.id, "echo two\n", { idleMs: 30 });
    expect(b.text).toContain("two");
    expect(b.text).not.toContain("one");
    expect(reg.read("s1", t.id, { all: true }).text).toContain("one");
  });

  it("scopes terminals to their session and reports exits", async () => {
    const { adapter } = fakePty();
    const reg = new TerminalRegistry(() => adapter);
    const t = await reg.open("s1", "/ws");
    expect(() => reg.read("other", t.id)).toThrow(/No terminal/);
    expect(reg.list("other")).toEqual([]);
    const r = await reg.send("s1", t.id, "exit\n", { idleMs: 30 });
    expect(r.alive).toBe(false);
    await expect(reg.send("s1", t.id, "echo x\n")).rejects.toThrow(/exited/);
  });

  it("stops waiting at the timeout and closes everything for a session", async () => {
    const { adapter, log } = fakePty();
    const reg = new TerminalRegistry(() => adapter);
    const t = await reg.open("s1", "/ws");
    await new Promise((r) => setTimeout(r, 20)); // let the prompt print
    const r = await reg.send("s1", t.id, "sleep 99\n", { idleMs: 30, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    reg.closeAll("s1");
    expect(log).toContain("kill:p1");
    expect(reg.list("s1")).toEqual([]);
  });
});

describe("terminal tools", () => {
  it("round-trips through the model-facing tools", async () => {
    const { adapter } = fakePty();
    const tools = Object.fromEntries(terminalTools({ registry: new TerminalRegistry(() => adapter), owner: "s1", cwd: "/ws" }).map((t) => [t.name, t]));
    const run = (name: string, args: object) => tools[name].execute(args as never, { callId: "c" } as never).then((r) => JSON.stringify(r));
    expect(await run("terminal_open", {})).toContain("term-1");
    expect(await run("terminal_send", { id: "term-1", input: "echo hi\n", timeoutMs: 2000 })).toContain("hi");
    expect(await run("terminal_list", {})).toContain("term-1");
    expect(await run("terminal_close", { id: "term-1" })).toContain("Closed");
    expect(await run("terminal_read", { id: "term-1" })).toContain("No terminal");
    expect(tools.terminal_send.risk({ id: "term-1", input: "rm -rf x" } as never)).toMatchObject({ class: "EXEC", command: "rm -rf x" });
  });
});
