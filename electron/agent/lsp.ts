/**
 * A small LSP client for read-only code navigation (definition, references,
 * implementation, hover) over a language server's stdio. v1 knows one server,
 * `typescript-language-server`, found on PATH; without it there is no tool.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const LSP_COMMAND = "typescript-language-server";
export const LSP_ARGS: readonly string[] = ["--stdio"];

const LANGUAGE: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
};
const REQUEST_TIMEOUT_MS = 60_000;

/** Absolute path of `command` on PATH, if any. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

export type LspOperation = "definition" | "references" | "implementation" | "hover";
const METHODS: Record<LspOperation, string> = {
  definition: "textDocument/definition", references: "textDocument/references",
  implementation: "textDocument/implementation", hover: "textDocument/hover",
};

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
interface Location { uri: string; range: { start: { line: number; character: number } } }

export class LspClient {
  private child?: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Map<string, { version: number; text: string }>();
  private ready?: Promise<void>;

  constructor(private readonly cwd: string, private readonly command: string, private readonly args: readonly string[]) {}

  private start(): Promise<void> {
    this.ready ??= (async () => {
      const child = spawn(this.command, [...this.args], { cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      child.stdout!.on("data", (d: Buffer) => this.onData(d));
      child.on("error", (err) => this.failAll(err));
      child.on("close", () => this.failAll(new Error("The language server exited.")));
      await this.request("initialize", {
        processId: process.pid, rootUri: pathToFileURL(this.cwd).href, workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }],
        capabilities: { textDocument: { definition: {}, references: {}, implementation: {}, hover: { contentFormat: ["markdown", "plaintext"] } } },
      });
      this.notify("initialized", {});
    })();
    return this.ready;
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
  }

  private send(msg: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    this.child?.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private notify(method: string, params: unknown): void { this.send({ method, params }); }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, headerEnd).toString("ascii"))?.[1];
      if (!length) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const end = headerEnd + 4 + Number(length);
      if (this.buf.length < end) return;
      const msg = JSON.parse(this.buf.subarray(headerEnd + 4, end).toString("utf8")) as { id?: number; method?: string; result?: unknown; error?: { message: string } };
      this.buf = this.buf.subarray(end);
      if (msg.id === undefined) continue;
      if (msg.method) { this.send({ id: msg.id, result: null }); continue; } // server-to-client request: acknowledge
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  }

  private sync(file: string): string {
    const text = readFileSync(file, "utf8");
    const uri = pathToFileURL(file).href;
    const doc = this.opened.get(uri);
    if (!doc) {
      this.opened.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: LANGUAGE[path.extname(file)] ?? "plaintext", version: 1, text } });
    } else if (doc.text !== text) {
      doc.version++; doc.text = text;
      this.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    }
    return uri;
  }

  /** `line` and `character` are 1-based. */
  async query(op: LspOperation, file: string, line: number, character: number): Promise<string> {
    await this.start();
    const uri = this.sync(file);
    const result = await this.request(METHODS[op], {
      textDocument: { uri }, position: { line: line - 1, character: character - 1 },
      ...(op === "references" ? { context: { includeDeclaration: true } } : {}),
    });
    return op === "hover" ? this.formatHover(result) : this.formatLocations(result);
  }

  private formatHover(result: unknown): string {
    const contents = (result as { contents?: unknown } | null)?.contents;
    if (!contents) return "No hover information.";
    const part = (c: unknown): string => typeof c === "string" ? c : (c as { value?: string })?.value ?? "";
    return (Array.isArray(contents) ? contents.map(part).join("\n\n") : part(contents)).trim() || "No hover information.";
  }

  private formatLocations(result: unknown): string {
    const list = (Array.isArray(result) ? result : result ? [result] : []) as Array<Location & { targetUri?: string; targetSelectionRange?: Location["range"] }>;
    if (!list.length) return "No results.";
    return list.slice(0, 100).map((l) => {
      const uri = l.uri ?? l.targetUri!;
      const start = (l.range ?? l.targetSelectionRange)!.start;
      const file = uri.startsWith("file:") ? path.relative(this.cwd, fileURLToPath(uri)) || uri : uri;
      let snippet = "";
      try { snippet = readFileSync(fileURLToPath(uri), "utf8").split("\n")[start.line]?.trim() ?? ""; } catch { /* outside the disk */ }
      return `${file}:${start.line + 1}:${start.character + 1}${snippet ? `  ${snippet}` : ""}`;
    }).join("\n");
  }

  dispose(): void {
    if (!this.child) return;
    try { this.notify("exit", null); } catch { /* already closed */ }
    this.child.kill("SIGTERM");
    this.child = undefined;
    this.ready = undefined;
  }
}

/** One language server per working directory, started on first use and shared by the sessions in it. */
export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  constructor(private readonly command: string | undefined = findOnPath(LSP_COMMAND), private readonly args: readonly string[] = LSP_ARGS) {}

  get available(): boolean { return this.command !== undefined; }

  client(cwd: string): LspClient {
    if (!this.command) throw new Error("No language server is installed.");
    let c = this.clients.get(cwd);
    if (!c) this.clients.set(cwd, c = new LspClient(cwd, this.command, this.args));
    return c;
  }

  disposeAll(): void { for (const c of this.clients.values()) c.dispose(); this.clients.clear(); }
}
