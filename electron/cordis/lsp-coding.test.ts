/**
 * lsp-coding tests — first-party LSP code navigation in the CODING stack.
 *
 * - Provider unit: seam + lsp-stdio against a scripted fake stdio server
 *   (real Content-Length framing + initialize handshake, no real language
 *   server binary, no network). Proves normalized definition/hover results
 *   and LSP_UNAVAILABLE for unmapped extensions.
 * - Mount: full mountCodingStack registers the `lsp` tool when a server
 *   binary is on PATH (fake `typescript-language-server` shim), and a
 *   chat-like context (mountFsChain only — the chat loop never calls
 *   mountCodingLsp) has neither `ctx.lsp` nor the tool.
 * - Lifecycle: missing binary → mountCodingStack still resolves with no
 *   `lsp` tool (fail-closed, turn proceeds); direct lsp-stdio plug with a
 *   bad command rejects fast with the PATH error; a hanging server aborts
 *   within budget (bounded, never hangs the turn).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { Context } from "@deepseek-ai/cordis";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import Lsp from "@deepseek-ai/dsh-lsp";
import * as LspStdio from "@deepseek-ai/dsh-lsp-stdio";

import { mountCodingStack, mountFsChain } from "./cordis-coding-tools";
import { mountCodingLsp } from "./cordis-lsp";

let root: string;
let ws: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-lsp-")));
  ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "a.ts"), "const x = 1\n");
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Minimal scripted LSP server over stdio. Answers `initialize` (utf-16,
 * full sync, all four providers) + `shutdown`/`exit`, and scripted
 * textDocument/* results — or hangs forever when `hang` is true (abort
 * test). Written as a file so both `node <file>` (stdio provider) and a
 * PATH shim script can exec it without quoting hazards.
 */
function writeFakeServer(extra: { hang?: boolean } = {}): string {
  const target = pathToFileURL(path.join(ws, "a.ts")).href;
  const script = `
let buf = Buffer.alloc(0);
const frame = (o) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...o }));
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]);
};
const DEF = ${JSON.stringify(JSON.stringify({ uri: target, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }))};
const HOVER = ${JSON.stringify(JSON.stringify({ contents: "const x: 1" }))};
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n");
    if (sep < 0) break;
    const len = Number(/(\\d+)/.exec(buf.toString("ascii", 0, sep))[1]);
    if (buf.length < sep + 4 + len) break;
    const m = JSON.parse(buf.toString("utf8", sep + 4, sep + 4 + len));
    buf = buf.subarray(sep + 4 + len);
    if (m.method === "initialize") {
      process.stdout.write(frame({ id: m.id, result: { capabilities: {
        positionEncoding: "utf-16", textDocumentSync: 1,
        definitionProvider: true, referencesProvider: true,
        implementationProvider: true, hoverProvider: true } } }));
    } else if (m.method === "textDocument/definition") {
      ${extra.hang ? "" : "process.stdout.write(frame({ id: m.id, result: JSON.parse(DEF) }));"}
    } else if (m.method === "textDocument/references" || m.method === "textDocument/implementation") {
      ${extra.hang ? "" : "process.stdout.write(frame({ id: m.id, result: [] }));"}
    } else if (m.method === "textDocument/hover") {
      ${extra.hang ? "" : "process.stdout.write(frame({ id: m.id, result: JSON.parse(HOVER) }));"}
    } else if (m.method === "shutdown") {
      process.stdout.write(frame({ id: m.id, result: null }));
    } else if (m.method === "exit") {
      process.exit(0);
    }
  }
});
`;
  const file = path.join(root, extra.hang ? "fake-lsp-hang.mjs" : "fake-lsp.mjs");
  fs.writeFileSync(file, script);
  return file;
}

function toolNames(ctx: Context): string[] {
  const tools = (ctx as any).tools as {
    schemas?: () => Array<{ name?: string; function?: { name?: string } }>;
  };
  const raw = tools?.schemas?.() ?? [];
  return raw
    .map((s) => s?.name ?? s?.function?.name ?? "")
    .filter(Boolean);
}

/** Globals mirror coding.live.test.ts so mountCodingStack resolves headless. */
async function mountGlobals(ctx: Context): Promise<void> {
  await ctx.plugin(sessionPlugin as never, {} as never);
  await ctx.plugin(llmPlugin as never, {} as never);
  await ctx.plugin(systemPromptPlugin as never, { persona: "", includeHarnessIdentity: false } as never);
  await ctx.plugin(agentPlugin as never, {} as never);
  await ctx.plugin(toolsPlugin as never, { mode: "native" } as never);
  const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection");
  await ctx.plugin(ProjectionRegistry as never, {} as never);
}

describe("lsp provider (fake stdio server)", () => {
  it("normalizes definition + hover through the seam", async () => {
    const serverFile = writeFakeServer();
    const ctx = new Context();
    try {
      await ctx.plugin(Lsp as never, {} as never);
      await ctx.plugin(LocalSubprocessRuntime as never, {} as never);
      await ctx.plugin(LocalFileSystem as never, { cwd: process.cwd() } as never);
      await ctx.plugin(LspStdio as never,
        {
          servers: {
            fake: {
              command: process.execPath,
              args: [serverFile],
              extensionToLanguage: { ".ts": "typescript" },
              shutdownTimeoutMs: 2000,
              killGraceMs: 500,
            },
          },
        } as never,
      );
      const lsp = (ctx as any).lsp as {
        query: (req: unknown, signal?: AbortSignal) => Promise<any>;
      };
      const def = await lsp.query({
        operation: "goToDefinition",
        filePath: "a.ts",
        position: { line: 0, character: 6 },
        workspaceRoot: ws,
      });
      expect(def.kind).toBe("locations");
      expect(def.locations).toHaveLength(1);
      expect(def.locations[0].uri).toBe(pathToFileURL(path.join(ws, "a.ts")).href);
      expect(def.resolvedWorkspaceUri).toBe(pathToFileURL(ws).href);
      const hover = await lsp.query({
        operation: "hover",
        filePath: "a.ts",
        position: { line: 0, character: 6 },
        workspaceRoot: ws,
      });
      expect(hover.kind).toBe("hover");
      expect(hover.hover?.contents).toContain("const x");
    } finally {
      await ctx.fiber.dispose();
    }
  }, 30000);

  it("fails closed with LSP_UNAVAILABLE for unmapped extensions", async () => {
    const serverFile = writeFakeServer();
    const ctx = new Context();
    try {
      await ctx.plugin(Lsp as never, {} as never);
      await ctx.plugin(LocalSubprocessRuntime as never, {} as never);
      await ctx.plugin(LocalFileSystem as never, { cwd: process.cwd() } as never);
      await ctx.plugin(LspStdio as never,
        {
          servers: {
            fake: {
              command: process.execPath,
              args: [serverFile],
              extensionToLanguage: { ".ts": "typescript" },
              shutdownTimeoutMs: 2000,
              killGraceMs: 500,
            },
          },
        } as never,
      );
      const lsp = (ctx as any).lsp as {
        query: (req: unknown, signal?: AbortSignal) => Promise<any>;
      };
      await expect(
        lsp.query({
          operation: "hover",
          filePath: "main.py",
          position: { line: 0, character: 0 },
          workspaceRoot: ws,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "LSP_UNAVAILABLE" }));
    } finally {
      await ctx.fiber.dispose();
    }
  }, 30000);
});

describe("lsp coding-stack mount", () => {
  it("coding YES: registers the lsp tool when a server is on PATH", async () => {
    const serverFile = writeFakeServer();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, "typescript-language-server");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${serverFile}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    const ctx = new Context();
    try {
      await mountGlobals(ctx);
      const disposeCoding = await mountCodingStack(ctx, { cwd: ws });
      try {
        expect((ctx as any).lsp).toBeDefined();
        expect(toolNames(ctx)).toContain("lsp");
        // End-to-end through the model tool shape (one-based UTF-16 cursor).
        const out = await (ctx as any).tools.execute({
          signal: new AbortController().signal,
          callId: "lsp-mount-test-1" as never,
          name: "lsp",
          arguments: { operation: "goToDefinition", file_path: "a.ts", line: 1, character: 7 },
          agent: { session: { header: { cwd: ws } } } as never,
        });
        expect(out?.isError ?? false).toBe(false);
      } finally {
        await disposeCoding();
      }
    } finally {
      await ctx.fiber.dispose();
    }
  }, 60000);

  it("chat NO: mountFsChain-only context has no seam and no lsp tool", async () => {
    const ctx = new Context();
    try {
      await mountGlobals(ctx);
      await mountFsChain(ctx, { cwd: ws });
      expect((ctx as any).lsp).toBeUndefined();
      expect(toolNames(ctx)).not.toContain("lsp");
    } finally {
      await ctx.fiber.dispose();
    }
  }, 60000);

  it("automation-dev persona mounts no LSP (no subprocess service)", async () => {
    const ctx = new Context();
    try {
      await mountGlobals(ctx);
      const result = await mountCodingLsp(ctx, async (plugin, config) => {
        await ctx.plugin(plugin as never, config as never);
      });
      // Bare ctx has no subprocess service at all — same early-out the
      // automation-dev stack hits (it skips subprocess registration).
      expect(result.mounted).toBe(false);
      expect(result.reason).toBe("no-subprocess");
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("lsp lifecycle", () => {
  it("missing binary: coding stack resolves with no lsp tool (fail-closed)", async () => {
    // Hermetic empty PATH: the probe cannot find any server regardless of
    // what the dev machine has installed.
    process.env.PATH = path.join(root, "empty-path");
    fs.mkdirSync(process.env.PATH, { recursive: true });
    const ctx = new Context();
    try {
      await mountGlobals(ctx);
      const disposeCoding = await mountCodingStack(ctx, { cwd: ws });
      try {
        expect((ctx as any).lsp).toBeUndefined();
        expect(toolNames(ctx)).not.toContain("lsp");
      } finally {
        await disposeCoding();
      }
    } finally {
      await ctx.fiber.dispose();
    }
  }, 60000);

  it("missing binary: direct stdio plug rejects fast with the PATH error", async () => {
    process.env.PATH = path.join(root, "empty-path");
    fs.mkdirSync(process.env.PATH, { recursive: true });
    const ctx = new Context();
    try {
      await ctx.plugin(Lsp as never, {} as never);
      await ctx.plugin(LocalSubprocessRuntime as never, {} as never);
      await ctx.plugin(LocalFileSystem as never, { cwd: process.cwd() } as never);
      await expect(
        ctx.plugin(
          LspStdio as never,
          {
            servers: {
              missing: {
                command: "typescript-language-server",
                args: ["--stdio"],
                extensionToLanguage: { ".ts": "typescript" },
              },
            },
          } as never,
        ),
      ).rejects.toThrow(/was not found on PATH/);
    } finally {
      await ctx.fiber.dispose();
    }
  }, 15000);

  it("hanging server: query aborts within budget (never hangs the turn)", async () => {
    const serverFile = writeFakeServer({ hang: true });
    const ctx = new Context();
    try {
      await ctx.plugin(Lsp as never, {} as never);
      await ctx.plugin(LocalSubprocessRuntime as never, {} as never);
      await ctx.plugin(LocalFileSystem as never, { cwd: process.cwd() } as never);
      await ctx.plugin(LspStdio as never,
        {
          servers: {
            hang: {
              command: process.execPath,
              args: [serverFile],
              extensionToLanguage: { ".ts": "typescript" },
              shutdownTimeoutMs: 2000,
              killGraceMs: 500,
            },
          },
        } as never,
      );
      const lsp = (ctx as any).lsp as {
        query: (req: unknown, signal?: AbortSignal) => Promise<any>;
      };
      await expect(
        lsp.query(
          {
            operation: "goToDefinition",
            filePath: "a.ts",
            position: { line: 0, character: 6 },
            workspaceRoot: ws,
          },
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow();
    } finally {
      await ctx.fiber.dispose();
    }
  }, 30000);
});
