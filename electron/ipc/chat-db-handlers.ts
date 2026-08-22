/**
 * Cairn — IPC handler for chat-thread CRUD channels (`db:chat:*`).
 *
 * Note: the streaming chat (`chat:stream` / `chat:abort` / `chat:compactThread`)
 * lives in `electron/ipc/chat.ts`. These handlers are the simpler CRUD surface
 * used by the renderer to populate the thread list + message history.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";

export function registerChatDbHandlers(ctx: DbContext): void {
  // Legacy transcript retirement: chat + pi-agent transcripts live exclusively
  // in dsh's JSONL session log (session-as-truth). The pre-Cordis SQLite body
  // tables have no readers left — drop them outright (idempotent; fresh DBs
  // never had them after this point).
  for (const t of ["chat_messages", "pi_agent_messages", "pi_agent_llm_history", "approval_items"]) {
    try { ctx.db.prepare(`DROP TABLE IF EXISTS ${t}`).run(); } catch { /* ignore */ }
  }
  registerIpcHandle("db:chat:threads", (_e, { workspaceId }) => handle(() => q.getChatThreads(ctx.db, workspaceId)));
  registerIpcHandle("db:chat:upsertThread", (_e, args: Parameters<typeof q.upsertChatThread>[1]) => handle(() => q.upsertChatThread(ctx.db, args)));

  // db:chat:clearThreadMessages — direct SQL DELETE + Cordis jsonl clear.
  // Mirrors pi-agent:clear's brute-force session wipe (pi-agent.ts:684) but for
  // a chat thread: delete every dsh session whose id is chat-<threadId>-* (the
  // per-turn sessionIds runCordisLoop mints) plus any subagent children
  // (origin==='subagent' && parentSession===stableId, stored as random UUIDs
  // like bb4c63a3… — the prefix scan alone would leave them orphaned and they'd
  // reappear as 6 blocks on reload). Also drop in-memory agents.
  registerIpcHandle("db:chat:clearThreadMessages", (_e, { threadId }) => handle(async () => {
    // Drop the cached live chat agent FIRST (see dropChatAgentForThread): the
    // module-global cache survives jsonl/ctx.agents wipes, and reusing a stale
    // agent both leaks pre-clear context into the next turn and writes to
    // deleted files (turns stop persisting). Dispose may flush pending events,
    // so this must run before the file wipe below removes them.
    try {
      const { dropChatAgentForThread } = require("../cordis/run-cordis-loop") as { dropChatAgentForThread: (id: string) => Promise<void> };
      await dropChatAgentForThread(threadId);
    } catch { /* best-effort; wipe still proceeds */ }
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const { getSessionRoot, getContext } = require("../cordis/run-cordis-loop");
      const primaryRoot = (getSessionRoot as () => string)();
      const fallbackRoot = path.join(process.cwd(), ".cairn-sessions");
      const roots = [primaryRoot, fallbackRoot].filter((r, i, a) => r && a.indexOf(r) === i);
    const stableId = `chat-${threadId}`;
    const prefix = `chat-${threadId}-`;
    // Collect subagent child ids for this thread so the prefix scan below doesn't miss them
    let subagentIds: string[] = [];
    try {
      const ctxInner = await getContext();
      const pers = (ctxInner as unknown as { sessionPersistence?: { list: () => Promise<Array<{ id: unknown; origin?: string; parentSession?: unknown; meta?: { origin?: string; parentSession?: unknown } }>> } }).sessionPersistence;
      if (pers?.list) {
        const list = await pers.list().catch(() => [] as Array<{ id: unknown }>);
        subagentIds = list.filter((h) => {
          const origin = (h as { origin?: string }).origin ?? (h as { meta?: { origin?: string } }).meta?.origin;
          const parent = (h as { parentSession?: unknown }).parentSession ?? (h as { meta?: { parentSession?: unknown } }).meta?.parentSession;
          return origin === "subagent" && String(parent) === String(stableId);
        }).map((h) => String((h as { id: unknown }).id));
      }
    } catch { /* subagent collect is best-effort */ }
      for (const root of roots) {
        // Nested layout: <root>/<encoded-cwd>/<sessionId>/session.jsonl.zstd
        // Handles both stable chat-<threadId> and legacy chat-<threadId>-<ts>-<rand>
        try {
          const projectDirs = fs.readdirSync(root, { withFileTypes: true } as unknown as { withFileTypes: true })
            .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
            .map((d: { name: string }) => d.name);
          for (const proj of projectDirs) {
            const projPath = path.join(root, proj);
            let entries: string[] = [];
            try {
              entries = fs.readdirSync(projPath, { withFileTypes: true } as unknown as { withFileTypes: true })
                .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
                .map((d: { name: string }) => d.name);
            } catch { continue; }
            for (const sess of entries) {
              const isChild = subagentIds.includes(sess);
              if (!isChild && sess !== threadId && sess !== stableId && !sess.startsWith(prefix) && !sess.startsWith(threadId)) continue;
              const base = path.join(projPath, sess);
              for (const p of [path.join(base, "session.jsonl.zstd"), path.join(base, "session.jsonl"), base + ".jsonl", path.join(base, "session.jsonl"), base]) {
                try {
                  if (fs.existsSync(p)) {
                    const stat = fs.statSync(p);
                    if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                    else fs.unlinkSync(p);
                  }
                } catch { /* ignore */ }
              }
            }
          }
        } catch { /* root not readable */ }
        // Flat fallbacks (old layout or _no-cwd): <root>/chat-<threadId>-*.jsonl and stable
        try {
          const flatEntries = fs.readdirSync(root, { withFileTypes: true } as unknown as { withFileTypes: true })
            .filter((d: { isFile: () => boolean; isDirectory: () => boolean }) => d.isFile() || d.isDirectory())
            .map((d: { name: string }) => d.name);
          for (const name of flatEntries) {
            if (name !== threadId && name !== stableId && !name.startsWith(prefix) && !name.startsWith(threadId)) continue;
            const p = path.join(root, name);
            try {
              if (fs.existsSync(p)) {
                const stat = fs.statSync(p);
                if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        for (const p of [path.join(root, stableId, "session.jsonl.zstd"), path.join(root, stableId, "session.jsonl"), path.join(root, stableId) + ".jsonl", path.join(root, stableId), path.join(root, threadId) + ".jsonl", path.join(path.join(root, threadId), "session.jsonl"), path.join(path.join(root, threadId), "session.jsonl.zstd"), path.join(root, threadId)]) {
          try {
            if (fs.existsSync(p)) {
              const stat = fs.statSync(p);
              if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
              else fs.unlinkSync(p);
            }
          } catch { /* ignore */ }
          }
        }
      // In-memory: drop any dsh agent whose id matches the thread (stable or legacy prefix).
      getContext().then((c: unknown) => {
        const maybeAgents: unknown = (c as { agents?: unknown })?.agents;
        if (!maybeAgents || typeof maybeAgents !== "object") return;
        const tryDelete = (id: unknown) => {
          for (const k of ["delete", "remove", "dispose", "destroy"] as const) {
            try {
              const fn = (maybeAgents as Record<string, unknown>)[k] as ((id: unknown) => unknown) | undefined;
              if (typeof fn === "function") { fn.call(maybeAgents, id); return true; }
            } catch { /* ignore */ }
          }
          try {
            const ag = (maybeAgents as { get?: (id: unknown) => { dispose?: () => void } })?.get?.(id) as { dispose?: () => void } | undefined;
            ag?.dispose?.();
            return true;
          } catch { /* ignore */ }
          return false;
        };
        // Stable + legacy + exact threadId + subagent children
        tryDelete(stableId);
        tryDelete({ toString: () => stableId } as unknown as string);
        tryDelete(threadId);
        tryDelete({ toString: () => threadId } as unknown as string);
        for (const sid of subagentIds) {
          tryDelete(sid);
          tryDelete({ toString: () => sid } as unknown as string);
        }
        // Enumerate map-like agents (Map, plain object, or dsh's internal store).
        const ids: string[] = [];
        try {
          if (maybeAgents instanceof Map) {
            for (const k of (maybeAgents as Map<unknown, unknown>).keys()) ids.push(String(k));
          } else if (Array.isArray((maybeAgents as { keys?: unknown })?.keys)) {
            // not expected
          } else {
            // Try to list via Object.keys if it's a plain record
            ids.push(...Object.keys(maybeAgents as Record<string, unknown>));
            // Also try .list/.entries if exposed
            const maybeList = (maybeAgents as { list?: () => string[]; entries?: () => Iterable<[unknown, unknown]> })?.list?.() ?? [];
            if (Array.isArray(maybeList)) ids.push(...maybeList.map(String));
          }
        } catch { /* ignore */ }
        for (const id of ids) {
          if (id === threadId || id === stableId || id.startsWith(prefix) || id.startsWith(threadId) || id.startsWith(stableId) || subagentIds.includes(id)) tryDelete(id);
        }
      }).catch(() => {});
    } catch { /* best-effort */ }
  }));

  registerIpcHandle("db:chat:clearAllThreads", (_e, { workspaceId, projectId }: { workspaceId: string; projectId?: string | null }) => handle(() => {
    const threads = q.getChatThreads(ctx.db, workspaceId).filter((t) => !projectId || t.projectId === projectId);
    const ids = threads.map((t) => t.id);
    if (ids.length === 0) return { deletedThreads: 0, deletedMessages: 0 };
    const placeholders = ids.map(() => "?").join(",");
    ctx.db.prepare(`DELETE FROM chat_threads WHERE id IN (${placeholders})`).run(...ids);
    // Also clear Cordis sessions for all deleted threads (best-effort, same brute-force as single clear)
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const { getSessionRoot, getContext } = require("../cordis/run-cordis-loop");
      const primaryRoot = (getSessionRoot as () => string)();
      const fallbackRoot = path.join(process.cwd(), ".cairn-sessions");
      const roots = [primaryRoot, fallbackRoot].filter((r, i, a) => r && a.indexOf(r) === i);
      for (const threadId of ids) {
        const prefix = `chat-${threadId}-`;
        for (const root of roots) {
          try {
            const projectDirs = fs.readdirSync(root, { withFileTypes: true } as unknown as { withFileTypes: true }).filter((d: { isDirectory: () => boolean }) => d.isDirectory()).map((d: { name: string }) => d.name);
            for (const proj of projectDirs) {
              const projPath = path.join(root, proj);
              let entries: string[] = [];
              try { entries = fs.readdirSync(projPath, { withFileTypes: true } as unknown as { withFileTypes: true }).filter((d: { isDirectory: () => boolean }) => d.isDirectory()).map((d: { name: string }) => d.name); } catch { continue; }
              for (const sess of entries) {
                if (sess !== threadId && !sess.startsWith(prefix) && !sess.startsWith(threadId)) continue;
                const base = path.join(projPath, sess);
                for (const p of [path.join(base, "session.jsonl.zstd"), path.join(base, "session.jsonl"), base + ".jsonl", path.join(base, "session.jsonl"), base]) {
                  try { if (fs.existsSync(p)) { const stat = fs.statSync(p); if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true }); else fs.unlinkSync(p); } } catch { /* ignore */ }
                }
              }
            }
          } catch { /* ignore */ }
          try {
            const flatEntries = fs.readdirSync(root, { withFileTypes: true } as unknown as { withFileTypes: true }).filter((d: { isFile: () => boolean; isDirectory: () => boolean }) => d.isFile() || d.isDirectory()).map((d: { name: string }) => d.name);
            for (const name of flatEntries) {
              if (name !== threadId && !name.startsWith(prefix) && !name.startsWith(threadId)) continue;
              const p = path.join(root, name);
              try { if (fs.existsSync(p)) { const stat = fs.statSync(p); if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true }); else fs.unlinkSync(p); } } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
      }
      getContext().then((c: unknown) => {
        const maybeAgents: unknown = (c as { agents?: unknown })?.agents;
        if (!maybeAgents || typeof maybeAgents !== "object") return;
        const tryDelete = (id: unknown) => {
          for (const k of ["delete", "remove", "dispose", "destroy"] as const) {
            try { const fn = (maybeAgents as Record<string, unknown>)[k] as ((id: unknown) => unknown) | undefined; if (typeof fn === "function") { fn.call(maybeAgents, id); return true; } } catch { /* ignore */ }
          }
          try { const ag = (maybeAgents as { get?: (id: unknown) => { dispose?: () => void } })?.get?.(id) as { dispose?: () => void } | undefined; ag?.dispose?.(); return true; } catch { /* ignore */ }
          return false;
        };
        const allIds: string[] = [];
        try {
          if (maybeAgents instanceof Map) { for (const k of (maybeAgents as Map<unknown, unknown>).keys()) allIds.push(String(k)); }
          else { allIds.push(...Object.keys(maybeAgents as Record<string, unknown>)); const maybeList = (maybeAgents as { list?: () => string[] })?.list?.() ?? []; if (Array.isArray(maybeList)) allIds.push(...maybeList.map(String)); }
        } catch { /* ignore */ }
        for (const tid of ids) {
          const pref = `chat-${tid}-`;
          tryDelete(tid);
          for (const aid of allIds) if (aid === tid || aid.startsWith(pref) || aid.startsWith(tid)) tryDelete(aid);
        }
      }).catch(() => {});
    } catch { /* ignore */ }
    return { deletedThreads: ids.length, deletedMessages: 0 };
  }));

  registerIpcHandle("db:chat:deleteThread", (_e, { threadId }) => handle(() => q.deleteChatThread(ctx.db, threadId)));
}
