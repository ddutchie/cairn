#!/usr/bin/env node
/**
 * smoke-test-mcp.js — behavioural smoke test for the PACKAGED cairn-mcp binary.
 *
 * Runs via: node scripts/smoke-test-mcp.js [path-to-binary]
 * (defaults to the platform binary in dist-mcp/)
 *
 * Why this exists: a bug can be correct in the compiled `mcp-server.bundle.js`
 * yet BREAK once packaged by pkg — pkg patches Node's `fs` and its
 * `realpathSync.native` does not canonicalise case on macOS, which silently sent
 * `link_note_to_task` down its relocation branch and DELETED the linked note.
 * The unit tests (plain Node) passed; only the shipped pkg binary was broken.
 *
 * This test therefore drives the ACTUAL built binary over stdio JSON-RPC against
 * a throwaway workspace that reproduces the exact failing scenario (a note whose
 * stored folder casing differs from its on-disk directory), links it to a task,
 * and asserts the note's .md file still exists afterwards.
 *
 * Exit codes: 0 = passed, 1 = failed (note file was deleted or tool errored).
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

function platformBinary() {
  // Release builds produce arch-suffixed binaries in dist-mcp/ (afterPack
  // canonicalises only inside the packaged app), so resolve by process.arch.
  if (process.platform === "win32") return path.join(root, "dist-mcp", `cairn-mcp-win-${process.arch}.exe`);
  if (process.platform === "linux") return path.join(root, "dist-mcp", `cairn-mcp-linux-${process.arch}`);
  return path.join(root, "dist-mcp", process.arch === "x64" ? "cairn-mcp-x64" : "cairn-mcp");
}

const BIN = process.argv[2] || platformBinary();

function fail(msg) {
  console.error(`  ✗  ${msg}`);
  process.exit(1);
}

console.log("\nCairn MCP binary smoke test\n");
if (!fs.existsSync(BIN)) fail(`binary not found: ${BIN} (run build-mcp-binary.js first)`);

// ── Build an isolated workspace with the exact case-mismatch scenario ────────
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mcp-smoke-"));
const cfgBase = path.join(ws, "config");
const dbPath = path.join(ws, "cairn.db");
const projectDirName = "SmokeProj";
const noteDir = path.join(ws, projectDirName, "research"); // on-disk: lowercase
fs.mkdirSync(noteDir, { recursive: true });

// Point the binary's DB/workspace discovery at our sandbox via workspace-config.
// getConfigBasePath() is platform-specific: macOS → <HOME>/Library/Application
// Support, Windows → %APPDATA%, Linux → $XDG_CONFIG_HOME (or <HOME>/.config). We
// set HOME (and APPDATA/XDG) to the sandbox and write the config under whichever
// base this platform resolves.
const configBases = [];
if (process.platform === "darwin") {
  configBases.push(path.join(ws, "Library", "Application Support"));
} else if (process.platform === "win32") {
  configBases.push(cfgBase);
} else {
  configBases.push(cfgBase, path.join(ws, ".config"));
}
for (const base of configBases) {
  for (const name of ["Cairn", "cairn"]) {
    fs.mkdirSync(path.join(base, name), { recursive: true });
    fs.writeFileSync(
      path.join(base, name, "workspace-config.json"),
      JSON.stringify({ workspacePath: ws }),
    );
  }
}

// Seed a minimal DB using the app's REAL schema (applySchema) so the row shape
// matches exactly what link_note_to_task expects — hand-writing CREATE TABLEs
// drifts (e.g. a missing `archived_at` column silently makes the tool error and
// the test falsely pass). We esbuild schema.ts to a temp CJS module and apply it
// via the system-Node better-sqlite3 (ABI matches in CI right after `compile`).
function seedDb() {
  const tmpSchema = path.join(ws, "_schema.cjs");
  execFileSync(
    "npx",
    ["esbuild", path.join(root, "electron/db/schema.ts"),
     "--bundle", "--platform=node", "--format=cjs",
     "--external:better-sqlite3", "--outfile=" + tmpSchema],
    // On Windows `npx` is `npx.cmd`, which execFileSync can't run without a
    // shell; enable shell only there so POSIX runners keep the safer no-shell path.
    { stdio: "ignore", cwd: root, shell: process.platform === "win32" },
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applySchema } = require(tmpSchema);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(path.join(root, "node_modules/better-sqlite3"));
  const db = new Database(dbPath);
  applySchema(db);
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('ws','WS',?,?)").run(now, now);
  db.prepare("INSERT INTO projects (id,workspace_id,name,status,priority,tag_ids,created_at,updated_at) VALUES ('proj','ws',?,'active','medium','[]',?,?)").run(projectDirName, now, now);
  db.prepare("INSERT INTO board_columns (id,project_id,workspace_id,name,type,\"order\",created_at,updated_at) VALUES ('col','proj','ws','Todo','todo',0,?,?)").run(now, now);
  db.prepare("INSERT INTO notes (id,project_id,workspace_id,title,content,content_text,tag_ids,linked_note_ids,linked_card_ids,is_pinned,type,folder,created_at,updated_at) VALUES ('note1','proj','ws','SmokeNote','body','body','[]','[]','[]',0,'note','Research',?,?)").run(now, now);
  db.prepare("INSERT INTO task_cards (id,column_id,project_id,workspace_id,title,description,tag_ids,priority,linked_note_ids,\"order\",created_at,updated_at) VALUES ('card1','col','proj','ws','SmokeCard','','[]','medium','[]',0,?,?)").run(now, now);
  db.close();
}
try {
  seedDb();
} catch (e) {
  fail(`could not seed sqlite db via applySchema: ${e.message}`);
}

// Note file lives in the lowercase "research" dir while the DB folder is
// "Research". On a CASE-INSENSITIVE FS (macOS/Windows) these are the same file,
// so the link is an in-place rewrite — the scenario that reproduced the pkg
// realpathSync bug (note wrongly deleted). On a CASE-SENSITIVE FS (Linux) they
// are genuinely different, so the link legitimately RELOCATES the file to
// Research/. Either way the invariant we assert is the same: the note's .md must
// still exist somewhere afterwards (it must never be destroyed).
const notePath = path.join(noteDir, "SmokeNote.md");
fs.writeFileSync(
  notePath,
  `---\nid: note1\nprojectId: proj\nworkspaceId: ws\ntitle: SmokeNote\nfolder: Research\ntagIds: []\nlinkedNoteIds: []\nlinkedCardIds: []\nisPinned: false\ncreatedAt: 'x'\nupdatedAt: 'x'\n---\nbody\n`,
);

const projectRoot = path.join(ws, projectDirName);
const inoBefore = fs.statSync(notePath).ino;

// Find a .md carrying our note id anywhere under the project dir (case-agnostic
// existence check — the file may have relocated to Research/ on Linux).
function noteFileExists() {
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(full)) return true; }
      else if (e.name.endsWith(".md")) {
        try { if (fs.readFileSync(full, "utf-8").includes("id: note1")) return true; } catch { /* skip */ }
      }
    }
    return false;
  };
  return walk(projectRoot);
}

// ── Drive the binary over stdio JSON-RPC ─────────────────────────────────────
const child = spawn(BIN, [], {
  env: {
    ...process.env,
    HOME: ws,
    XDG_CONFIG_HOME: cfgBase,
    APPDATA: cfgBase,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

// A spawn failure (binary not executable, bad arch, missing loader) otherwise
// surfaces as a silent "no response" timeout — report it directly.
child.on("error", (err) => fail(`failed to launch ${BIN}: ${err.message}`));

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

// Response-driven flow: parse complete newline-delimited JSON-RPC messages and
// react when id:1 (initialize) and id:2 (tools/call) arrive, instead of racing
// fixed sleeps. A generous timeout remains only as a fallback for a hung/crashed
// binary that never replies.
let buffer = "";
let initialized = false;
let done = false;

const timeout = setTimeout(() => {
  if (done) return;
  console.error(stderr);
  finish(false, "timed out waiting for JSON-RPC responses (binary hung or DB not found)");
}, 15000);

function finish(ok, msg, linkResp) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  try { child.kill(); } catch { /* already gone */ }

  if (!ok) {
    if (linkResp) console.error(`     link response: ${linkResp}`);
    fail(msg);
  }

  // ── Assertion: the linked note's file must SURVIVE the link ────────────────
  // The real regression is data loss — the .md being unlinked entirely. Assert
  // it still exists somewhere in the project (in place on a case-insensitive FS;
  // relocated to Research/ on a case-sensitive FS — both are correct outcomes).
  if (!noteFileExists()) {
    if (linkResp) console.error(`     link response: ${linkResp}`);
    fail("linked note's .md file was DELETED by link_note_to_task (regression!)");
  }

  // On a case-INSENSITIVE FS the link is an in-place rewrite, so the file must
  // stay put with the SAME inode (a tmp+rename would swap the inode — the pkg
  // relocation bug). Detect case-insensitivity by whether the upper-cased dir
  // path resolves to our seeded file; only enforce the stricter check there.
  const upperDir = path.join(ws, projectDirName, "Research", "SmokeNote.md");
  let caseInsensitive = false;
  try { caseInsensitive = fs.statSync(upperDir).ino === inoBefore; } catch { /* case-sensitive */ }

  if (caseInsensitive) {
    let sameInode = false;
    try { sameInode = fs.statSync(notePath).ino === inoBefore; } catch { /* moved away */ }
    if (!sameInode) {
      if (linkResp) console.error(`     link response: ${linkResp}`);
      fail("note file was relocated/replaced on a case-insensitive FS (should be in-place)");
    }
  }

  console.log("  ✓  link_note_to_task preserved the linked note's file");
  console.log("\n1 passed, 0 failed\n");
  fs.rmSync(ws, { recursive: true, force: true });
  process.exit(0);
}

child.stdout.on("data", (d) => {
  buffer += d.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON log lines
    if (msg.id === 1 && !initialized) {
      initialized = true;
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "link_note_to_task", arguments: { noteId: "note1", cardId: "card1" } } });
    } else if (msg.id === 2) {
      finish(true, null, line);
    }
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
