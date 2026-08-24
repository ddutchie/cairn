/**
 * Cairn — IPC handler for chat-thread CRUD channels (`db:chat:*`).
 *
 * Note: the streaming chat (`session:prompt` / `session:abort` / `chat:compactThread`)
 * lives in `electron/ipc/chat.ts`. These handlers are the simpler CRUD surface
 * used by the renderer to populate the thread list + message history.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { assertSafeId, resolveWithinRoot, isSafeId } from "./path-safety";
import fs from "node:fs";
import path from "node:path";
import { dropChatAgentForThread, getSessionRoot, getContext } from "../cordis/run-cordis-loop";

export function registerChatDbHandlers(ctx: DbContext): void {
  // Legacy SQLite transcript tables and pre-Cordis session indexes are reset by
  // migrations v49/v51. New history is owned by dsh JSONL sessions.
  registerIpcHandle("db:chat:threads", (_e, { workspaceId }) => handle(() => q.getChatThreads(ctx.db, workspaceId)));
  registerIpcHandle("db:chat:upsertThread", (_e, args: Parameters<typeof q.upsertChatThread>[1]) => handle(() => q.upsertChatThread(ctx.db, args)));

  // db:chat:clearThreadMessages — direct SQL DELETE + Cordis jsonl clear.
  // Mirrors the coding session runtime's brute-force session wipe but for
  // a chat thread: delete every dsh session whose id is chat-<threadId>-* (the
  // per-turn sessionIds runCordisLoop mints) plus any subagent children
  // (origin==='subagent' && parentSession===stableId, stored as random UUIDs
  // like bb4c63a3… — the prefix scan alone would leave them orphaned and they'd
  // reappear as 6 blocks on reload). Also drop in-memory agents.
  registerIpcHandle("db:chat:clearThreadMessages", (_e, { threadId }) => handle(async () => {
    // Reject renderer-supplied ids that could path-traverse before they reach
    // fs.rmSync() below. Any legitimate `thr-<nanoid>` passes; `..`, `/`, `\`,
    // empty, over-length, control chars all fail here.
    assertSafeId(threadId, "threadId");
    // Chat todo snapshots use the dsh session id, not the chat-thread id. Clear
    // both forms so a stale todo list cannot reappear when the thread resumes
    // after its transcript has been wiped.
    q.saveSessionTodos(ctx.db, `chat-${threadId}`, []);
    q.saveSessionTodos(ctx.db, threadId, []);
    // Drop the cached live chat agent FIRST (see dropChatAgentForThread): the
    // module-global cache survives jsonl/ctx.agents wipes, and reusing a stale
    // agent both leaks pre-clear context into the next turn and writes to
    // deleted files (turns stop persisting). Dispose may flush pending events,
    // so this must run before the file wipe below removes them.
    try {
      await dropChatAgentForThread(threadId);
    } catch { /* best-effort; wipe still proceeds */ }
    try {
      const primaryRoot = getSessionRoot();
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
        // Flat fallbacks (root-level session dirs / .jsonl variants). threadId
        // is assertSafeId-validated at the handler entry; every path below is
        // additionally containment-checked via resolveWithinRoot as defence
        // in depth. Composed paths that would escape `root` are silently
        // skipped (already-safe ids never trigger the null branch).
        const stableDir = resolveWithinRoot(root, stableId);
        const threadDir = resolveWithinRoot(root, threadId);
        const candidates: string[] = [];
        if (stableDir) candidates.push(path.join(stableDir, "session.jsonl.zstd"), path.join(stableDir, "session.jsonl"), stableDir + ".jsonl", stableDir);
        if (threadDir) candidates.push(threadDir + ".jsonl", path.join(threadDir, "session.jsonl"), path.join(threadDir, "session.jsonl.zstd"), threadDir);
        for (const p of candidates) {
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
    // Ids come from SQLite, but filter for path-safety anyway — a corrupt row
    // (e.g. from a compromised sync peer or a manual DB edit) must not turn
    // this handler into a path-traversal sink.
    const ids = threads.map((t) => t.id).filter(isSafeId);
    if (ids.length === 0) return { deletedThreads: 0, deletedMessages: 0 };
    const placeholders = ids.map(() => "?").join(",");
    ctx.db.prepare(`DELETE FROM chat_threads WHERE id IN (${placeholders})`).run(...ids);
    // Also clear Cordis sessions for all deleted threads (best-effort, same brute-force as single clear)
    try {
      const primaryRoot = getSessionRoot();
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
