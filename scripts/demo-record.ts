/**
 * Cairn — Demo video recorder (captures the REAL app at high bitrate)
 *
 * Boots the actual Electron app, seeds a fixture workspace with realistic
 * Cairn-themed content, opens the Chat view and runs "summarize this project"
 * through the real UI — waiting for the reply to fully stream — then tours a
 * couple of views. The app's renderer is captured DIRECTLY via
 * webContents.capturePage() and piped into ffmpeg at a high bitrate, bypassing
 * Playwright's lossy recordVideo encoder entirely, so the source is crisp.
 *
 * Requires the live model bridge (CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local), the
 * Next dev server, and ffmpeg. Run:
 *   npm run compile
 *   CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local node --experimental-strip-types scripts/demo-record.ts
 *
 * Output: <repo>/electron-recordings/demo.mp4 (set RECORD_DIR to change).
 */

import { _electron as electron } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";
const MAIN = path.resolve("dist-electron/main.js");
const RECORD_DIR = process.env.RECORD_DIR ?? path.resolve("electron-recordings");
// Match the Electron BrowserWindow's 1400x900 exactly (no letterboxing/borders).
const W = 1400;
const H = 900;
// Capture rate — a UI demo is fine around 12fps; bump for smoother motion.
const FPS = 12;

if (process.env.CORDIS_LIVE !== "1") {
  console.error("Set CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local to record a demo (needs the model bridge).");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rmSync(p: string) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}
function cleanStaleDemoTmp() {
  // Previous runs left cairn-demo-* and cairn-verify-* in os.tmpdir() (the demo
  // previously did not clean up). Remove them so we don't leak disk.
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith("cairn-demo-") || name.startsWith("cairn-verify")) {
        rmSync(path.join(os.tmpdir(), name));
      }
    }
  } catch {}
  // Also clear any leftover session.jsonl.zstd in /tmp from cordis runs
  try { fs.rmSync("/tmp/session.jsonl", { force: true }); } catch {}
  try { fs.rmSync("/tmp/session.jsonl.zstd", { force: true }); } catch {}
}

/**
 * Captures the app's renderer by polling webContents.capturePage() and saving
 * lossless PNG frames to a temp stream. After the demo, the frames are encoded
 * to a high-bitrate mp4 with a two-pass libx264 encode (reliable target bitrate
 * from the lossless source). Call .start() after the app is up, .stop() before
 * closing it; await .finished() after stop to run the encode.
 */
function createCapturer(app: import("@playwright/test").ElectronApplication) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const outPath = path.join(RECORD_DIR, "demo.mp4");
  // Temp file holding the concatenated lossless PNG frames.
  const framesPath = path.join(RECORD_DIR, ".frames.png");
  const framesOut = fs.createWriteStream(framesPath);

  let running = false;
  let capturing = false;
  let frameCount = 0;
  const errs: string[] = [];

  async function grabOne(): Promise<void> {
    if (!running || !capturing) return;
    try {
      // PNG bytes of the renderer, base64-encoded across the IPC boundary. The
      // evaluate callback receives the whole electron module, so webContents is
      // available as a top-level key.
      const b64 = await app.evaluate((electronMod) => {
        const wc = (electronMod as any).webContents.getAllWebContents()
          .find((w: any) => w.getURL().startsWith("http://localhost:3000"));
        if (!wc) return null;
        return wc.capturePage().then((img: any) => img.toPNG().toString("base64"));
      });
      if (b64) {
        framesOut.write(Buffer.from(b64, "base64"));
        frameCount++;
      }
    } catch {
      // app closing / capture failure — ignore, keep looping
    }
  }

  const loop = async () => {
    while (running) {
      const t0 = Date.now();
      await grabOne();
      const elapsed = Date.now() - t0;
      if (elapsed < 1000 / FPS) await sleep(1000 / FPS - elapsed);
    }
  };

  let loopPromise: Promise<void> = Promise.resolve();

  return {
    start() {
      running = true;
      capturing = true;
      loopPromise = loop();
    },
    async stop() {
      running = false;
      await loopPromise;
      // Await the write stream fully flushing BEFORE returning, so `finished()`
      // can safely read the whole frames file. (Waiting here avoids the race
      // where finished() attaches a 'close' listener after the stream already
      // closed — which would hang forever.)
      await new Promise<void>((r) => framesOut.end(() => r()));
    },
    /**
     * Encode the captured lossless frames into the final mp4. Uses constant
     * quality (CRF), not a bitrate target: for a UI demo the frames are mostly
     * static, so an ABR/bitrate target can't "fill" a high bitrate and actually
     * converges low. CRF guarantees every frame is crisp and lets the bitrate
     * reflect real detail (high during the chat stream, low on idle frames) —
     * which is exactly what you want for readable text. Captures at Retina 2x,
     * so the output is 2800x1800 unless REC_SIZE scaling is applied.
     */
    async finished() {
      const { execFileSync } = await import("child_process");
      const fps = String(FPS);
      const args = [
        "-y", "-f", "image2pipe", "-framerate", fps, "-c:v", "png",
        "-i", framesPath,
        "-c:v", "libx264", "-preset", "slow",
        // CRF 13 ≈ near-transparent quality from a lossless source; 4:2:0 for
        // broad player compatibility. Keep the native Retina resolution.
        "-crf", "13",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        outPath,
      ];
      execFileSync("ffmpeg", args, { stdio: "inherit" });
      try { fs.unlinkSync(framesPath); } catch { /* keep for debugging */ }
      return { outPath, frames: frameCount };
    },
    get errors() { return errs; },
  };
}

async function main() {
  cleanStaleDemoTmp();
  // Isolated profile + workspace.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-demo-userdata-"));
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-demo-ws-")), "vault");
  const workspaceParent = path.dirname(workspace);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(userData, "workspace-config.json"), JSON.stringify({ workspacePath: workspace }, null, 2));
  fs.writeFileSync(
    path.join(userData, "ai-settings-cache.json"),
    JSON.stringify({
      aiConfig: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" },
      agentConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", maxSteps: 8, autoApprove: true },
    }, null, 2),
  );

  let app: any = null;
  let capturer: any = null;
  try {
  app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, NODE_ENV: "development", CAIRN_USER_DATA_DIR: userData, CAIRN_NO_DEVTOOLS: "1" },
  });

  let page: any;
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    page = app.windows().find((w: any) => w.url().startsWith("http://localhost:3000"));
    if (page) break;
    await sleep(250);
  }
  if (!page) throw new Error("Could not find the app renderer window");

  // Wait for the store to attach.
  for (let i = 0; i < 200; i++) {
    const ready = await page.evaluate(() => !!(window as any).__cairnStoreRef).catch(() => false);
    if (ready) break;
    await sleep(300);
  }

  // Start high-bitrate capture of the renderer.
  capturer = createCapturer(app);
  capturer.start();

  // ── Seed a realistic, Cairn-themed workspace so the video tells a story ──
  // Seeding MUST be awaitable so cards survive the reload (hydrateFromElectron
  // reads from SQLite). createNote/createCard in the store are fire-and-forget
  // (debounced localStorage + async IPC), so we seed cards directly via the
  // awaitable IPC `db:card:create` handle and poll the snapshot until it lands.
  const seeded = await page.evaluate(async (wsp) => {
    const s = (window as any).__cairnStoreRef.getState();
    await s.initWorkspacePath(wsp);
    const s2 = (window as any).__cairnStoreRef.getState();
    const wobj = await s2.createWorkspace("Cairn HQ", "🗂️");
    const proj = await s2.createProject(wobj.id, "Cairn — Personal Knowledge Base", "🧠");

    // Re-read authoritative columns from the DB snapshot — the store's
    // optimistic placeholder columns (set immediately) have different IDs than
    // the server rows. Using placeholders causes FOREIGN KEY failures on
    // db:card:create (seen as "FOREIGN KEY constraint failed"). Poll the
    // snapshot until the 5 server columns appear.
    let cols: any[] = [];
    const snapApi = (window as any).electron?.snapshot;
    if (snapApi) {
      for (let i = 0; i < 40; i++) {
        try {
          const snap: any = await snapApi();
          cols = (snap.columns ?? []).filter((c: any) => c.projectId === proj.id);
          if (cols.length >= 5) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 75));
      }
    }
    // Fallback to in-memory store if snapshot not available (tests).
    if (cols.length < 5) {
      const cur = (window as any).__cairnStoreRef.getState();
      cols = cur.columns.filter((c: any) => c.projectId === proj.id);
    }
    const colByName = Object.fromEntries(cols.map((c: any) => [c.name, c.id]));
    const colByType: Record<string, string> = Object.fromEntries(cols.map((c: any) => [c.type, c.id]));

    const notes = [
      ["Product Vision", "# Product Vision\n\nCairn is a local-first notes, tasks and agentic desktop app.\n\n- **Private by default** — everything stays on your machine\n- **AI that works with your data** — chat, coding agent, and automations\n- **Beautiful, fast** — a delight to open every day"],
      ["Roadmap 2026", "# Roadmap 2026\n\n- **Q3** — Onboarding polish, sync engine, widget gallery\n- **Q4** — Mobile companion app, shared workspaces\n- **This sprint** — Cordis runtime for every AI loop, faster streaming"],
      ["Agent Principles", "# Agent Principles\n\nThe built-in coding agent should feel like a trusted teammate:\n\n- Plan before acting; ask before destructive changes\n- Keep a clear todo list the user can see\n- Prefer the workspace's own tools and conventions"],
      ["Meeting — User Research", "# User Research — May\n\n**Likes**\n- 'It finally understands my vault'\n- 'The agent reads my notes and just gets it'\n\n**Wants**\n- Cross-note AI summaries\n- Smarter automations that watch the workspace"],
    ];
    for (const [t, c] of notes) {
      (window as any).__cairnStoreRef.getState().createNote(proj.id, t, "note", "", c);
    }

    // Give the debounced localStorage+markdown flush a tick (notes survive via
    // .md files + SQLite, but the file flush races the reload otherwise).
    await new Promise((r) => setTimeout(r, 300));

    const workspaceId = wobj.id;
    const tasks: Array<{ title: string; col: string; due?: string; assignee?: string }> = [
      // Backlog — upcoming
      { title: "Design the mobile companion app", col: "Backlog", assignee: "Maya" },
      { title: "Evaluate an embedded sync engine (CRDTs)", col: "Backlog" },
      { title: "Widget gallery — Publish, Metrics, Focus", col: "Backlog", assignee: "Leo" },
      // Todo — next up
      { title: "Ship the shared-workspaces beta", col: "Todo", due: "2026-09-01", assignee: "Aria" },
      { title: "Write onboarding copy for new vaults", col: "Todo", due: "2026-08-25" },
      // In Progress — active this sprint
      { title: "Port the coding agent onto the Cordis runtime", col: "In Progress", due: "2026-08-22", assignee: "Sam" },
      { title: "Stream thinking blocks for the chat loop", col: "In Progress", due: "2026-08-21", assignee: "Sam" },
      { title: "Add cross-note AI summaries", col: "In Progress", due: "2026-08-28", assignee: "Aria" },
      // Review — waiting on validation
      { title: "Verify the heartbeat automation runner", col: "Review", due: "2026-08-20", assignee: "Leo" },
      // Done — shipped
      { title: "Local-first notes with markdown vaults", col: "Done", assignee: "Maya" },
      { title: "Agent automations that watch the workspace", col: "Done", assignee: "Sam" },
      { title: "Knowledge graph + insights canvases", col: "Done", assignee: "Aria" },
    ];

    // Use the awaitable IPC directly (store's createCard is fire-and-forget).
    // Fall back to store method if the IPC isn't present (tests without Electron).
    const cardApi = (window as any).electron?.card;
    let created = 0;
    for (const t of tasks) {
      const colId = colByName[t.col] ?? (t.col === "Backlog" ? colByType["backlog"] : undefined);
      if (!colId) continue;
      if (cardApi?.create) {
        try {
          const res: any = await cardApi.create({
            id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            columnId: colId,
            projectId: proj.id,
            workspaceId,
            title: t.title,
            description: "",
            priority: "medium",
            dueDate: t.due ?? null,
            order: 0,
            tagIds: [],
            assignee: t.assignee ?? null,
          });
          if (!res?.error) created++;
        } catch {
          // fall through to store method
          (window as any).__cairnStoreRef.getState().createCard(colId, proj.id, t.title, { dueDate: t.due, assignee: t.assignee });
          created++;
        }
      } else {
        (window as any).__cairnStoreRef.getState().createCard(colId, proj.id, t.title, { dueDate: t.due, assignee: t.assignee });
        created++;
      }
    }

    // Ensure the cards are visible in the DB snapshot BEFORE we reload.
    // Poll snapshot (authoritative) rather than in-memory store.
    if (snapApi) {
      for (let i = 0; i < 30; i++) {
        try {
          const snap: any = await snapApi();
          const n = (snap.cards ?? []).filter((c: any) => c.projectId === proj.id).length;
          if (n >= Math.min(created, tasks.length) && n > 0) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
    } else {
      await new Promise((r) => setTimeout(r, 800));
    }

    const s3 = (window as any).__cairnStoreRef.getState();
    s3.setAIConfig({ provider: "openai", baseUrl: "http://localhost:3042/v1", model: "claude-sonnet-4-5", apiKey: "local" });
    s3.setAgentConfig({ baseUrl: "http://localhost:3042/v1", model: "claude-sonnet-4-5", apiKey: "local", maxSteps: 8, autoApprove: true });
    s3.setActiveProject(proj.id);
    // Flush the debounced persist (200ms) before the reload or cards vanish.
    await new Promise((r) => setTimeout(r, 600));
    return { projectId: proj.id, workspaceId, created, colCount: cols.length };
  }, workspace);

  console.log(`[demo] seeded workspace ${seeded.workspaceId} project ${seeded.projectId} cols=${seeded.colCount} cards=${seeded.created}`);

  // Reload so the app hydrates the seeded workspace and settles into the shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1200);
  // Hide What's New immediately (was 4000ms+400ms before) so capture isn't blocked.
  await page.evaluate(() => {
    try {
      const s: any = (window as any).__cairnStoreRef?.getState?.();
      if (s) {
        const latestIds = [
          "v2.7.0-responses-api",
          "v2.7.4-automation-mini-app",
          "v2.7.5-note-fonts",
          "v2.7.5-chat-themes",
          "v2.7.7-cordis-coding-engine",
        ];
        for (const id of latestIds) try { s.markFeatureAsSeen(id); } catch {}
        try { localStorage.setItem("seenFeatures", JSON.stringify(s.seenFeatures ?? latestIds)); } catch {}
      }
    } catch {}
    try {
      const style = document.createElement("style");
      style.setAttribute("data-demo-hide-whats-new", "1");
      style.textContent = '[role="dialog"]{display:none !important} .fixed.inset-0.bg-black\\/50,.fixed.inset-0.backdrop-blur-sm,.fixed.inset-0.bg-black{display:none !important}';
      document.head.appendChild(style);
      document.querySelectorAll('[role="dialog"]').forEach((el) => { (el as HTMLElement).style.display = "none"; });
    } catch {}
  }).catch(() => {});
  await sleep(100);
  // Verify snapshot quickly (was 4000ms) — just for logging.
  const post = await page.evaluate(async () => {
    try {
      const snap: any = await (window as any).electron?.snapshot?.();
      if (!snap) return { ok: false, reason: "no snapshot api" };
      const s: any = (window as any).__cairnStoreRef.getState();
      const pid = s.activeProjectId;
      const cards = (snap.cards ?? []).filter((c: any) => c.projectId === pid);
      const cols = (snap.columns ?? []).filter((c: any) => c.projectId === pid);
      return { ok: true, cards: cards.length, cols: cols.length, pid };
    } catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; }
  });
  console.log(`[demo] post-reload snapshot:`, post);
  if (post && (post as any).ok && (post as any).cards === 0) {
    console.warn(`[demo] WARNING: board still empty after reload — tasks did not persist`);
  }

  // ── Chat view: ask for a summary, wait for the FULL reply ──
  await page.evaluate(() => (window as any).__cairnStoreRef.getState().setView("chat"));
  await sleep(600);

  const donePromise = page.evaluate(() => {
    return new Promise((resolve) => {
      const unsub = window.electron.session.onDone((e: any) => {
        if (e.error || (e.content && e.content.trim().length > 0)) {
          unsub();
          resolve(e);
        }
      });
    });
  });

  const input = page.getByPlaceholder(/Ask about your project/);
  await input.waitFor({ timeout: 30_000 });
  await input.click();
  await input.type("Summarize this Project.", { delay: 22 });
  await sleep(700);
  await page.keyboard.press("Enter");

  await donePromise;
  await sleep(2500);

  // ── Tour a few views so the video shows the app's breadth (quicker) ──
  await page.evaluate(() => (window as any).__cairnStoreRef.getState().setView("overview"));
  await sleep(1200);
  await page.evaluate(() => (window as any).__cairnStoreRef.getState().setView("notes"));
  await sleep(1200);
  await page.evaluate(() => (window as any).__cairnStoreRef.getState().setView("board"));
  await sleep(1200);

  // ── Stop capture, close the app, then two-pass encode the lossless frames ──
  await capturer.stop();
  await app.close();

  const { outPath, frames } = await capturer.finished();
  if (capturer.errors.length) console.error("capture errors:", capturer.errors);
  console.log(`Captured ${frames} frames -> ${outPath}`);
  } finally {
    try { if (capturer) await capturer.stop().catch(() => {}); } catch {}
    try { if (app) await app.close().catch(() => {}); } catch {}
    rmSync(userData);
    rmSync(workspaceParent);
    // Clean any leftover session files the run left in /tmp
    try { cleanStaleDemoTmp(); } catch {}
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  // Ensure temp folders are cleaned even on crash
  try { cleanStaleDemoTmp(); } catch {}
  process.exit(1);
});
