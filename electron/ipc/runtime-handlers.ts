import { registerIpcHandle, broadcastEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as runtime from "../runtime/client";
import { BrowserWindow } from "electron";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { makeSessionProjection } from "../../shared/agent/session-projection";
import { getAgentHost } from "../cordis/agent-host";

let progressForwarderSetUp = false;

function ensureProgressForwarder(getWin: () => BrowserWindow | null): void {
  if (progressForwarderSetUp) return;
  progressForwarderSetUp = true;
  runtime.onProgress((ev) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (ev.kind === "progress") {
      win.webContents.send("runtime:download-progress", {
        modelId: ev.modelId,
        status: ev.status,
        file: ev.file,
        progress: ev.progress,
        loaded: ev.loaded,
        total: ev.total,
      });
    } else if (ev.kind === "ready") {
      win.webContents.send("runtime:download-progress", {
        modelId: ev.modelId,
        status: "ready",
        progress: 100,
      });
    } else if (ev.kind === "binary-progress") {
      win.webContents.send("runtime:binary-progress", {
        progress: ev.progress,
        speed: ev.speed,
        status: ev.status,
        error: ev.error,
      });
    }
  });
}

export function registerRuntimeHandlers(ctx: DbContext): void {
  ensureProgressForwarder(ctx.getWin);
  // ── Command execution (dsh commands runtime) ────────────────────────
  // List registry commands (name + description) so host UIs can render their
  // palettes from the same namespace plugins register into.
  registerIpcHandle("cordis:listCommands", () => handle(async () => {
    try {
      const list = await getAgentHost().listCommands();
      return list.map((c) => ({ name: c.name, description: c.description ?? "" }));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // Generic executor for registry commands (/plan, /compact, plugin commands)
  // on a session's resumed agent. Returns the command result {kind, text}.
  registerIpcHandle("cordis:executeCommand", (_e, req: { sessionId: string; line: string }) => handle(async () => {
    try {
      const agentConfig = (await import("../lib/config-cache")).getCachedConfig().agentConfig;
      const result = await getAgentHost().executeCommand({
        sessionId: req.sessionId,
        cwd: ctx.workspacePath || process.cwd(),
        baseUrl: agentConfig?.baseUrl ?? "",
        model: agentConfig?.model ?? "",
        apiKey: agentConfig?.apiKey ?? "",
        line: req.line,
      });
      if (result.mode) {
        try {
          q.updateCodingSession(ctx.db, req.sessionId, { mode: result.mode, updatedAt: ts() });
        } catch { }
        broadcastEvent("session:projection", makeSessionProjection(req.sessionId, "mode-change", { mode: result.mode }));
      }
      return { kind: result.kind, text: result.text };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // ── Runtime health & lifecycle ─────────────────────────────
  registerIpcHandle("runtime:status", () => handle(async () => {
    return runtime.getRuntimeStatus();
  }));

  registerIpcHandle("runtime:stop", () => handle(async () => {
    await runtime.stopRuntime({ force: true });
    return { ok: true };
  }));

  // ── System-prompt introspection (Cordis) ─────────────────────────────
  // Assemble the REAL dsh system prompt the Cordis engine sends, plus a
  // breakdown of its sections (name + order). Cairn's own identity section
  // (cairn:system) is mounted per-turn inside the loop, so to reflect a real
  // turn we temporarily mount it here, assemble, then remove it. The coding
  // agent prompt (buildAgentSystemPrompt — the board-tracking workflow) is a
  // plain string (no dsh sections), returned alongside so Settings shows both.
  registerIpcHandle("runtime:systemPrompt:preview", (_e, req: { cwd?: string; projectName?: string }) => handle(async () => {
    try {
      return await getAgentHost().previewSystemPrompt(req?.cwd ?? "");
    } catch (err) {
      return { text: "", sections: [], skillCount: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // ── Coding-agent prompt preview ──────────────────────────────────────
  // The coding loop's system prompt is NOT a dsh section — it is the plain
  // string built by buildAgentSystemPrompt (identity + Mandatory Cairn
  // workflow: board tracking, PRD checklists, session summaries). The 3.0
  // Cordis cutover moved it out of the assembled dsh prompt, so the preview
  // above no longer shows it. Return it here so Settings can display it.
  registerIpcHandle("runtime:codingPrompt:preview", (_e, req: { cwd?: string; projectName?: string; taskTitle?: string }) => handle(async () => {
    try {
      const { buildAgentSystemPrompt } = await import("../lib/coding-session-prompt");
      const cwd = req?.cwd ?? ctx.workspacePath ?? process.cwd();
      const text = buildAgentSystemPrompt({
        projectName: req?.projectName ?? "Project",
        cwd,
        taskTitle: req?.taskTitle,
        mode: "execute",
        role: "default",
      });
      return { text };
    } catch (err) {
      return { text: "", error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // ── Tool inventory (per-surface, dynamic) ────────────────────────────
  // What the model can actually call differs per surface (chat = Cairn data
  // tools only; coding = + filesystem/exec stack; automation-dev = file
  // tools only; MCP = minus chat-only). Static part comes from
  // lib/tool-inventory (same sources the loops use); global dsh tools
  // (subagent/delegate/jobs/skill/web_fetch/…) are read live from the
  // registry and merged in.
  registerIpcHandle("runtime:tools:inventory", () => handle(async () => {
    try {
      const [{ buildStaticInventory }] = await Promise.all([
        import("../lib/tool-inventory"),
      ]);
      const globalTools = (await getAgentHost().getGlobalTools()).map((tool) => ({ ...tool, description: tool.description ?? "", category: "exec" as const, source: "global" as const }));
      const surfaces = buildStaticInventory(globalTools);
      return { surfaces };
    } catch (err) {
      return { surfaces: null, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // ── Embedding model management (via unified runtime) ────────
  registerIpcHandle("runtime:embeddings:status", () => handle(() => {
    return runtime.getEmbeddingsStatus();
  }));

  registerIpcHandle("runtime:embeddings:ensureStarted", () => handle(async () => {
    await runtime.ensureStarted();
    return { ok: true };
  }));

  registerIpcHandle("runtime:embeddings:models", () => handle(async () => {
    return { models: await runtime.listEmbeddingModels() };
  }));

  registerIpcHandle("runtime:embeddings:install", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.installEmbeddingModel(modelId);
    return { ok: true };
  }));

  registerIpcHandle("runtime:embeddings:remove", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.removeEmbeddingModel(modelId);
    return { ok: true };
  }));

  registerIpcHandle("runtime:embeddings:setDefault", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.setDefaultEmbeddingModel(modelId);
    return { ok: true };
  }));

}
