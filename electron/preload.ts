/**
 * Cairn — Preload script
 *
 * Exposes a typed `window.electron` API to the renderer via contextBridge.
 * Only whitelisted channels are accessible — the renderer has no access
 * to Node.js or Electron internals directly.
 *
 * Each electron/preload/<domain>.ts module builds its slice from the typed
 * helpers in electron/preload/ipc.ts; esbuild bundles them into one file.
 */

import { contextBridge } from "electron";
import { workspaceApi } from "./preload/workspace";
import { notesApi } from "./preload/notes";
import { boardApi } from "./preload/board";
import { flowApi } from "./preload/flow";
import { graphApi } from "./preload/graph";
import { automationsApi } from "./preload/automations";
import { chatApi } from "./preload/chat";
import { aiApi } from "./preload/ai";
import { userStyleApi } from "./preload/user-style";
import { syncApi } from "./preload/sync";
import { notificationsApi } from "./preload/notifications";
import { agentApi } from "./preload/agent";
import { toolsApi } from "./preload/tools";
import { gitApi } from "./preload/git";
import { sessionApi } from "./preload/session";
import { runtimeApi } from "./preload/runtime";
import { appApi } from "./preload/app";

const api = {
  ...workspaceApi,
  ...notesApi,
  ...boardApi,
  ...flowApi,
  ...graphApi,
  ...automationsApi,
  ...chatApi,
  ...aiApi,
  ...userStyleApi,
  ...syncApi,
  ...notificationsApi,
  ...agentApi,
  ...toolsApi,
  ...gitApi,
  ...sessionApi,
  ...runtimeApi,
  ...appApi,
} as const;

contextBridge.exposeInMainWorld("electron", api);

// ── Type export for the renderer ────────────────
// Import this type in the renderer to get full type safety on window.electron
export type ElectronAPI = typeof api;
