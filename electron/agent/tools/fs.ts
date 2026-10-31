/**
 * Filesystem tools: read, write, edit, read_image, glob, grep. Same names and
 * argument shapes the model already knows. Write and edit refuse to touch an
 * existing file this session has not read (so edits are made against content
 * the model has actually seen).
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { clampMiddle, fail, ok } from "./schema";

export interface FsDeps {
  /** Session working directory; relative paths resolve against it. */
  cwd: string;
  /** Absolute paths this session has read or written. Pass the same set for the whole session. */
  observed?: Set<string>;
  /** Absolute path of the ripgrep binary. */
  rgPath: string;
}

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_SEARCH_BYTES = 256 * 1024;
const MAX_GLOB_RESULTS = 1000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function rg(deps: FsDeps, args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(deps.rgPath, args, { cwd, signal });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length >= MAX_SEARCH_BYTES) { truncated = true; child.kill(); return; }
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 8_192) stderr += d.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code, truncated }));
  });
}

export function fsTools(deps: FsDeps, opts: { readOnly?: boolean } = {}): AgentTool[] {
  const observed = deps.observed ?? new Set<string>();
  const abs = (p: string) => path.resolve(deps.cwd, p);

  const read = defineTool({
    name: "read",
    description: "Read a UTF-8 text file and return line-numbered content.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to read; relative paths resolve against the session working directory." }),
      offset: Type.Optional(Type.Number({ description: "1-based first line to return. Defaults to 1." })),
      limit: Type.Optional(Type.Number({ description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.` })),
    }),
    risk: (a) => ({ class: "READ", paths: [abs(a.file_path)] }),
    concurrency: "parallel",
    async execute(a) {
      const file = abs(a.file_path);
      try {
        const buf = await readFile(file);
        if (buf.subarray(0, 8192).includes(0)) return fail(`${a.file_path} looks like a binary file`);
        observed.add(file);
        const lines = buf.toString("utf8").split("\n");
        const start = Math.max(1, Math.floor(a.offset ?? 1));
        const limit = Math.max(1, Math.floor(a.limit ?? DEFAULT_READ_LIMIT));
        const slice = lines.slice(start - 1, start - 1 + limit);
        if (slice.length === 0) return ok(`(no lines at offset ${start}; the file has ${lines.length} lines)`);
        const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l}`).join("\n");
        const more = start - 1 + slice.length < lines.length ? `\n… ${lines.length - (start - 1 + slice.length)} more lines; continue with offset ${start + slice.length}` : "";
        return ok(body + more);
      } catch (err) {
        return fail(`Cannot read ${a.file_path}: ${errText(err)}`);
      }
    },
  });

  const readImage = defineTool({
    name: "read_image",
    description: "Read a PNG, JPEG, GIF or WebP image so you can look at it.",
    parameters: Type.Object({ file_path: Type.String({ description: "Image path." }) }),
    risk: (a) => ({ class: "READ", paths: [abs(a.file_path)] }),
    concurrency: "parallel",
    async execute(a) {
      const mime = IMAGE_TYPES[path.extname(a.file_path).toLowerCase()];
      if (!mime) return fail("Unsupported image type; use png, jpg, gif or webp");
      try {
        const buf = await readFile(abs(a.file_path));
        return { content: [{ type: "image", data: buf.toString("base64"), mimeType: mime }] };
      } catch (err) {
        return fail(`Cannot read ${a.file_path}: ${errText(err)}`);
      }
    },
  });

  const glob = defineTool({
    name: "glob",
    description: "Find files by glob pattern (respects .gitignore). Returns paths relative to the search directory.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob such as **/*.ts" }),
      path: Type.Optional(Type.String({ description: "Directory to search. Defaults to the working directory." })),
    }),
    risk: (a) => ({ class: "READ", paths: [abs(a.path ?? ".")] }),
    concurrency: "parallel",
    async execute(a, ctx) {
      try {
        const dir = abs(a.path ?? ".");
        const r = await rg(deps, ["--files", "--hidden", "--glob", "!.git", "--glob", a.pattern, "--sort", "path"], dir, ctx.signal);
        if (r.code !== 0 && r.code !== 1) return fail(r.stderr.trim() || `glob failed (exit ${r.code})`);
        const files = r.stdout.split("\n").filter(Boolean);
        if (files.length === 0) return ok("No files matched");
        const shown = files.slice(0, MAX_GLOB_RESULTS);
        return ok(shown.join("\n") + (files.length > shown.length || r.truncated ? `\n… more matches; narrow the pattern` : ""));
      } catch (err) {
        return fail(`glob failed: ${errText(err)}`);
      }
    },
  });

  const grep = defineTool({
    name: "grep",
    description: "Search file contents with ripgrep (regex). Respects .gitignore.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression." }),
      path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the working directory." })),
      glob: Type.Optional(Type.String({ description: "Only search files matching this glob." })),
      output_mode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], { description: "content (default) shows matching lines." })),
      ignore_case: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Number({ description: "Lines of context around each match (content mode)." })),
    }),
    risk: (a) => ({ class: "READ", paths: [abs(a.path ?? ".")] }),
    concurrency: "parallel",
    async execute(a, ctx) {
      const mode = a.output_mode ?? "content";
      const args = ["--hidden", "--glob", "!.git", "--max-columns", "500"];
      if (a.ignore_case) args.push("-i");
      if (a.glob) args.push("--glob", a.glob);
      if (mode === "files_with_matches") args.push("-l");
      else if (mode === "count") args.push("-c");
      else { args.push("-n", "--no-heading"); if (a.context) args.push("-C", String(Math.min(10, Math.max(0, Math.floor(a.context))))); }
      args.push("-e", a.pattern, "--", abs(a.path ?? "."));
      try {
        const r = await rg(deps, args, deps.cwd, ctx.signal);
        if (r.code === 1 && !r.stdout) return ok("No matches");
        if (r.code !== 0 && r.code !== 1 && !r.truncated) return fail(r.stderr.trim() || `grep failed (exit ${r.code})`);
        return ok(clampMiddle(r.stdout, MAX_SEARCH_BYTES) + (r.truncated ? "\n… output truncated; narrow the search" : ""));
      } catch (err) {
        return fail(`grep failed: ${errText(err)}`);
      }
    },
  });

  if (opts.readOnly) return [read, readImage, glob, grep];

  const guardObserved = async (file: string, shown: string): Promise<string | undefined> => {
    const exists = await stat(file).then(() => true, () => false);
    return exists && !observed.has(file) ? `Read ${shown} before changing it` : undefined;
  };

  const write = defineTool({
    name: "write",
    description: "Create or fully replace a UTF-8 text file. Read an existing file before overwriting it; prefer edit for targeted changes.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to write." }),
      content: Type.String({ description: "Full text content." }),
    }),
    risk: (a) => ({ class: "WRITE_LOCAL", paths: [abs(a.file_path)] }),
    preview: (a) => a.content,
    async execute(a) {
      const file = abs(a.file_path);
      const refusal = await guardObserved(file, a.file_path);
      if (refusal) return fail(refusal);
      try {
        const existed = await stat(file).then(() => true, () => false);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, a.content, "utf8");
        observed.add(file);
        return ok(`${existed ? "Updated" : "Created"} ${a.file_path} (${a.content.split("\n").length} lines)`);
      } catch (err) {
        return fail(`Cannot write ${a.file_path}: ${errText(err)}`);
      }
    },
  });

  const edit = defineTool({
    name: "edit",
    description: "Edit an existing UTF-8 text file by replacing literal text. Read the file first.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to edit." }),
      old_string: Type.String({ description: "Literal text to replace." }),
      new_string: Type.String({ description: "Replacement text; empty deletes the match." }),
      replace_all: Type.Optional(Type.Boolean({ description: "Replace every match. Otherwise old_string must appear exactly once." })),
    }),
    risk: (a) => ({ class: "WRITE_LOCAL", paths: [abs(a.file_path)] }),
    preview: (a) => `${a.old_string}\n→\n${a.new_string}`,
    async execute(a) {
      const file = abs(a.file_path);
      let text: string;
      try { text = await readFile(file, "utf8"); } catch (err) { return fail(`Cannot read ${a.file_path}: ${errText(err)}`); }
      const refusal = await guardObserved(file, a.file_path);
      if (refusal) return fail(refusal);
      if (!a.old_string) return fail("old_string must not be empty");
      if (a.old_string === a.new_string) return fail("old_string and new_string are identical");
      const count = text.split(a.old_string).length - 1;
      if (count === 0) return fail(`old_string not found in ${a.file_path}`);
      if (count > 1 && !a.replace_all) return fail(`old_string appears ${count} times in ${a.file_path}; add context to make it unique or set replace_all`);
      const next = a.replace_all ? text.split(a.old_string).join(a.new_string) : text.replace(a.old_string, () => a.new_string);
      try { await writeFile(file, next, "utf8"); } catch (err) { return fail(`Cannot write ${a.file_path}: ${errText(err)}`); }
      observed.add(file);
      return ok(`Edited ${a.file_path} (${a.replace_all ? count : 1} replacement${count > 1 && a.replace_all ? "s" : ""})`);
    },
  });

  return [read, write, edit, readImage, glob, grep];
}
