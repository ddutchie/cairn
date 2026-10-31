import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findOnPath, LspManager } from "./lsp";
import { lspTool } from "./tools/lsp";

const cwd = mkdtempSync(path.join(os.tmpdir(), "lsp-"));
const file = path.join(cwd, "a.ts");
writeFileSync(file, "export const answer = 42;\nconsole.log(answer);\n");

// A stand-in language server: speaks the framing, answers the four navigation requests from fixed data.
const server = path.join(cwd, "fake-server.js");
writeFileSync(server, `
const uri = ${JSON.stringify(pathToFileURL(file).href)};
let buf = Buffer.alloc(0);
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m })); process.stdout.write("Content-Length: " + b.length + "\\r\\n\\r\\n"); process.stdout.write(b); };
const loc = (line, character) => ({ uri, range: { start: { line, character }, end: { line, character: character + 6 } } });
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf("\\r\\n\\r\\n"); if (h < 0) return;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const m = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()); buf = buf.subarray(h + 4 + len);
    if (m.id === undefined) { if (m.method === "textDocument/didOpen") globalThis.opened = m.params.textDocument.languageId; continue; }
    const r = { initialize: { capabilities: {} },
      "textDocument/definition": loc(0, 13), "textDocument/references": [loc(0, 13), loc(1, 12)],
      "textDocument/implementation": null, "textDocument/hover": { contents: { kind: "markdown", value: "const answer: 42 (" + globalThis.opened + ")" } } }[m.method];
    send(m.method === "textDocument/nope" ? { id: m.id, error: { message: "nope" } } : { id: m.id, result: r === undefined ? null : r });
  }
});
`);

const manager = new LspManager(process.execPath, [server]);
afterAll(() => manager.disposeAll());
const tool = lspTool({ manager, cwd })!;
const run = (args: object) => tool.execute(args as never, { callId: "c" } as never).then((r) => String((r as { content: string }).content));

describe("lsp", () => {
  it("is absent without a language server", () => {
    expect(lspTool({ manager: new LspManager(undefined), cwd })).toBeUndefined();
    expect(findOnPath("definitely-not-a-real-binary-xyz")).toBeUndefined();
    expect(findOnPath("sh")).toBeTruthy();
  });

  it("answers definition and references with relative 1-based locations and a source line", async () => {
    expect(await run({ operation: "definition", path: "a.ts", line: 2, character: 13 })).toBe("a.ts:1:14  export const answer = 42;");
    expect((await run({ operation: "references", path: "a.ts", line: 1, character: 14 })).split("\n")).toEqual(["a.ts:1:14  export const answer = 42;", "a.ts:2:13  console.log(answer);"]);
  });

  it("reports empty results and hover text, tagging the file's language", async () => {
    expect(await run({ operation: "implementation", path: "a.ts", line: 1, character: 1 })).toBe("No results.");
    expect(await run({ operation: "hover", path: "a.ts", line: 1, character: 14 })).toContain("const answer: 42 (typescript)");
  });

  it("is a READ-class tool on the file it inspects", () => {
    expect(tool.risk({ operation: "hover", path: "a.ts", line: 1, character: 1 } as never)).toEqual({ class: "READ", paths: [file] });
  });
});
