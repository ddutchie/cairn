import { registerIpcHandle, broadcastEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as runtime from "../runtime/client";
import { BrowserWindow } from "electron";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { foldPlanModeActive } from "../cordis/plan-fold";
import { makeSessionProjection } from "../../shared/agent/session-projection";

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
      const { getContext } = await import("../cordis/run-cordis-loop");
      const cordisCtx = await getContext();
      const commands = (cordisCtx as unknown as { commands?: { list?: () => Array<{ name: string; description?: string }> } }).commands;
      const list = commands?.list?.() ?? [];
      return list.map((c) => ({ name: c.name, description: c.description ?? "" }));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // Generic executor for registry commands (/plan, /compact, plugin commands)
  // on a session's resumed agent. Returns the command result {kind, text}.
  registerIpcHandle("cordis:executeCommand", (_e, req: { sessionId: string; line: string }) => handle(async () => {
    try {
      const [{ getContext }, { openCordisAgent }] = await Promise.all([
        import("../cordis/run-cordis-loop"),
        import("../cordis/run-cordis-coding"),
      ]);
      const cordisCtx = await getContext();
      const agentConfig = (await import("../lib/config-cache")).getCachedConfig().agentConfig;
      const handle = await openCordisAgent(cordisCtx, {
        sessionId: req.sessionId,
        cwd: ctx.workspacePath || process.cwd(),
        llmConfig: { baseUrl: agentConfig?.baseUrl ?? "", model: agentConfig?.model ?? "", apiKey: agentConfig?.apiKey ?? "", provider: "openai" },
        signal: undefined,
      });
      try {
        const commands = (cordisCtx as unknown as { commands?: { list?: unknown; execute: (a: unknown, line: string, imgs: unknown[], s: AbortSignal) => Promise<unknown> } }).commands;
        if (!commands) return { error: "commands runtime unavailable" };
        const out = await commands.execute((handle as { agent: unknown }).agent, req.line, [], new AbortController().signal) as { result?: { kind?: string; text?: string } } | undefined;
        const r = out?.result ?? (out as { kind?: string; text?: string } | undefined);
        const commandName = req.line.trim().replace(/^\//, "").split(/\s+/, 1)[0];
        if (commandName === "plan" && r?.kind === "success") {
          const agent = (handle as { agent: { session?: unknown } }).agent;
          const mode = foldPlanModeActive(agent.session as never) ? "plan" : "execute";
          try {
            q.updateCodingSession(ctx.db, req.sessionId, { mode, updatedAt: ts() });
          } catch { /* chat sessions do not have a Cairn coding-session row */ }
          broadcastEvent("session:projection", makeSessionProjection(req.sessionId, "mode-change", { mode }));
        }
        return { kind: r?.kind, text: r?.text };
      } finally {
        try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
      }
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
  // (cairn:system:*) is mounted per-turn inside the loop, so to reflect a real
  // turn we temporarily mount it here, assemble, then remove it.
  registerIpcHandle("runtime:systemPrompt:preview", (_e, req: { cwd?: string }) => handle(async () => {
    try {
      const [{ getContext }, { buildSystemPrompt }] = await Promise.all([
        import("../cordis/run-cordis-loop"),
        import("../lib/tools"),
      ]);
      const ctx = await getContext();
      const sys = (ctx as unknown as {
        systemPrompt?: {
          assemble: (c: { scope?: unknown; signal?: AbortSignal }) => Promise<unknown>;
          section: (s: { name: string; order: number; text: string }) => () => void;
        };
      }).systemPrompt;
      if (!sys) return { text: "", sections: [], skillCount: 0, error: "systemPrompt service unavailable" };
      // Mount Cairn's identity section at order -100 (same as the chat loop) so
      // the assembled text is what a real turn sends.
      const disposeSection = sys.section({ name: "cairn:system:preview", order: -100, text: buildSystemPrompt({ message: "", threadId: "preview", projectId: "", workspaceId: "" } as never) });
      try {
        const assembly = (await sys.assemble({ signal: undefined })) as {
          sections: Array<{ name: string; order: number; text: string | ((c: { scope?: unknown }) => string) }>;
          contexts: Array<{ name: string; order: number; text: string | ((c: { scope?: unknown }) => string) }>;
          variables: Record<string, string | undefined>;
          tools: unknown[];
        };
        const { renderPrompt } = await import("@deepseek-ai/dsh-system-prompt");
        const text = renderPrompt(assembly as unknown as Parameters<typeof renderPrompt>[0]);
        const textOf = (v: string | ((c: { scope?: unknown }) => string)) =>
          typeof v === "function" ? v({}) : v;
        // The assembled sections are {name, text} (order is a registration-only
        // prop that assemble() strips) — use index as a stable display order.
        const sections = assembly.sections
          .map((s, i) => ({ name: s.name, order: i, text: textOf(s.text), index: i }));
        const contexts = assembly.contexts.map((c) => ({ name: c.name, order: c.order, text: textOf(c.text) }));
        // Skills: full list (name + description) from the shared registry.
        let skills: Array<{ name: string; description: string }> = [];
        try {
          const skillsSvc = (ctx as unknown as { skills?: { list: (o: { cwd: string }) => Promise<Array<{ name: string; description: string }>> } }).skills;
          if (skillsSvc) skills = await skillsSvc.list({ cwd: req?.cwd ?? "" });
        } catch { /* informational */ }
        // Tools: enumerate the global view (per-turn Cairn tools register inside
        // a loop, so this reflects globally-registered + plugin tools).
        const tools: Array<{ name: string; description?: string }> = [];
        try {
          const toolsSvc = (ctx as unknown as { tools?: { view: (s?: unknown) => { visible: Map<string, unknown> } } }).tools;
          const vis = toolsSvc?.view?.()?.visible;
          if (vis) {
            for (const name of vis.keys()) {
              const def = vis.get(name) as { description?: string } | undefined;
              tools.push({ name, description: def?.description });
            }
            tools.sort((a, b) => a.name.localeCompare(b.name));
          }
        } catch { /* informational */ }
        return { text, sections, contexts, skills, tools, variables: assembly.variables ?? {} };
      } finally {
        disposeSection();
      }
    } catch (err) {
      return { text: "", sections: [], skillCount: 0, error: err instanceof Error ? err.message : String(err) };
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

  // ── LLM model management (via unified runtime) ─────────────
  registerIpcHandle("runtime:llm:models", () => handle(async () => {
    return { models: await runtime.listLLMModels() };
  }));

  registerIpcHandle("runtime:llm:install", (_e, { modelId, useMirror }: { modelId: string; useMirror?: boolean }) => handle(async () => {
    await runtime.installLLMModel(modelId, useMirror);
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:remove", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.removeLLMModel(modelId);
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:start", (_e, { modelId, contextLimit }: { modelId: string; contextLimit?: number }) => handle(async () => {
    const port = await runtime.startLLMServer(modelId, contextLimit);
    return { port };
  }));

  registerIpcHandle("runtime:llm:stop", () => handle(async () => {
    await runtime.stopLLMServer();
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:status", () => handle(async () => {
    return runtime.getLLMStatus();
  }));

  registerIpcHandle("runtime:llm:checkUpdate", () => handle(async () => {
    return runtime.checkLLMBinaryUpdate();
  }));

  registerIpcHandle("runtime:llm:binary:install", () => handle(async () => {
    await runtime.installLLMBinary();
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:clearInactive", () => handle(async () => {
    await runtime.clearInactiveLLMModels();
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:server:setDefault", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.setDefaultLLMModel(modelId);
    return { ok: true };
  }));
}
