/** Chat threads and the pop-out window. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { ChatPopoutPayload } from "../../shared/agent/chat-popout";
import type { IpcArgs, IpcEvents } from "../../shared/ipc/contract";
import type { ChatThreadUpsertInput } from "../../shared/types/chat";

export const chatApi = {
  // ── Chat ─────────────────────────────────────
  chat: {
    threads:       (workspaceId: string) => invokeContract("db:chat:threads", { workspaceId }),
    sessionMessages: (threadId: string) => invokeContract("db:chat:sessionMessages", { threadId }),
    upsertThread:  (input: ChatThreadUpsertInput) => invokeContract("db:chat:upsertThread", input),
    deleteThread:  (threadId: string) => invokeContract("db:chat:deleteThread", { threadId }),
    clearThreadMessages: (threadId: string) => invokeContract("db:chat:clearThreadMessages", { threadId }),
    clearAllThreads: (workspaceId: string, projectId?: string) => invokeContract("db:chat:clearAllThreads", { workspaceId, projectId }),
    compactThread: (req: IpcArgs<"chat:compactThread">[0]) => invokeContract("chat:compactThread", req),
    summarizeTranscript: (req: IpcArgs<"chat:summarizeTranscript">[0]) => invokeContract("chat:summarizeTranscript", req),
    // ── Pop-out window ──────────────────────────
    /** Called by main window: sends current chat state, triggers window creation. */
    popOut: (payload: ChatPopoutPayload) => invokeContract("chat:popOut", payload),
    /** Called by pop-out page: signals readiness, returns the shared session id. */
    popoutReady: () => invokeContract("chat:popoutReady"),
    /** Called by pop-out page: closes the window; session state is not copied. */
    popIn: (payload: { sessionId: string }) => invokeContract("chat:popIn", payload),
    /** Called by main window: asks the pop-out to return (relayed via main process). */
    requestPopIn: () => invokeContract("chat:requestPopIn"),
    /** Listener on the main window: received when pop-in completes with final state. */
    onChatPoppedIn: (cb: (payload: IpcEvents["chat:poppedIn"]) => void) => onIpcEvent("chat:poppedIn", cb),
    /** Listener on the main window: pop-out closed unexpectedly (e.g. Cmd+W). */
    onChatPoppedOutClosed: (cb: () => void) => onIpcEvent("chat:poppedOutClosed", () => cb()),
    /** Listener on the pop-out page: received when main window requests pop-in. */
    onChatRequestPopIn: (cb: () => void) => onIpcEvent("chat:requestPopIn", () => cb()),
    /** Listener on the pop-out page: received when main window pushes an updated session (C2 race fix). */
    onChatSessionUpdated: (cb: (payload: ChatPopoutPayload) => void) => onIpcEvent("chat:sessionUpdated", cb),
  },
} as const;
