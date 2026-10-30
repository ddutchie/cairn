/** terminal_*: persistent shells the model can type into across tool calls. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { clampMiddle, fail, ok } from "./schema";
import type { TerminalRegistry } from "../terminals";

export interface TerminalDeps { registry: TerminalRegistry; owner: string; cwd: string }

const MAX_OUTPUT = 30_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"] as const;

const attempt = async (run: () => string | Promise<string>) => {
  try { return ok(await run()); } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
};
const render = (r: { text: string; alive: boolean; exitCode?: number; timedOut?: boolean }) =>
  `${clampMiddle(r.text.trimEnd(), MAX_OUTPUT) || "(no output)"}${r.alive ? "" : `\n[terminal exited${r.exitCode !== undefined ? ` with ${r.exitCode}` : ""}]`}${r.timedOut ? "\n[still running — read more output with terminal_read]" : ""}`;

export function terminalTools({ registry, owner, cwd }: TerminalDeps): AgentTool[] {
  return [
    defineTool({
      name: "terminal_open",
      description: "Open a persistent interactive shell. Use it for long-lived processes or state that must survive between commands (cd, env vars, REPLs). Returns the terminal id.",
      parameters: Type.Object({}),
      risk: () => ({ class: "EXEC", command: "terminal_open" }),
      execute: () => attempt(async () => { const t = await registry.open(owner, cwd); return `Opened ${t.id} in ${t.cwd}.`; }),
    }),
    defineTool({
      name: "terminal_send",
      description: "Type input into a terminal (end a command with a newline to run it) and return the output once it goes quiet.",
      parameters: Type.Object({
        id: Type.String(),
        input: Type.String({ description: "Text to type, e.g. \"npm test\\n\"." }),
        timeoutMs: Type.Optional(Type.Number({ description: "Stop waiting after this long (default 30000)." })),
      }),
      risk: (a) => ({ class: "EXEC", command: a.input }),
      preview: (a) => a.input,
      execute: (a, ctx) => attempt(async () => render(await registry.send(owner, a.id, a.input, { timeoutMs: a.timeoutMs, signal: ctx.signal }))),
    }),
    defineTool({
      name: "terminal_read",
      description: "Read output a terminal printed since your last read or send.",
      parameters: Type.Object({ id: Type.String(), all: Type.Optional(Type.Boolean({ description: "Return the whole scrollback instead." })) }),
      risk: () => ({ class: "READ" }),
      execute: (a) => attempt(() => render(registry.read(owner, a.id, { all: a.all }))),
    }),
    defineTool({
      name: "terminal_signal",
      description: "Send a signal (default SIGINT, i.e. Ctrl-C) to the terminal's shell.",
      parameters: Type.Object({ id: Type.String(), signal: Type.Optional(Type.Union(SIGNALS.map((s) => Type.Literal(s)))) }),
      risk: () => ({ class: "EXEC", command: "terminal_signal" }),
      execute: (a) => attempt(() => { registry.signal(owner, a.id, a.signal ?? "SIGINT"); return `Sent ${a.signal ?? "SIGINT"} to ${a.id}.`; }),
    }),
    defineTool({
      name: "terminal_close",
      description: "Close a terminal and everything running in it.",
      parameters: Type.Object({ id: Type.String() }),
      risk: () => ({ class: "READ" }),
      execute: (a) => attempt(() => { registry.close(owner, a.id); return `Closed ${a.id}.`; }),
    }),
    defineTool({
      name: "terminal_list",
      description: "List this session's terminals.",
      parameters: Type.Object({}),
      risk: () => ({ class: "READ" }),
      execute: () => attempt(() => registry.list(owner).map((t) => `${t.id}  ${t.alive ? "running" : "exited"}  ${t.cwd}`).join("\n") || "No terminals."),
    }),
  ];
}
