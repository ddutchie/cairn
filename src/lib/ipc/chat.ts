/**
 * Typed client for chat threads (`db:chat:*`, `chat:*`) and the pop-out
 * window. Every failure rejects with the main-process message; off-Electron
 * calls reject with `IpcUnavailableError`.
 */
import type { ChatPopoutPayload } from "../../../shared/agent/chat-popout";
import type { IpcArgs, IpcEvents } from "../../../shared/ipc/contract";
import type { ChatThreadUpsertInput } from "../../../shared/types/chat";
import { domainCall, type ElectronApi } from "./client";

type ChatApi = NonNullable<ElectronApi["chat"]>;
const chat = <T>(fn: (api: ChatApi) => Promise<T>) => domainCall("chat", fn);

export const chatClient = {
  threads: (workspaceId: string) => chat((c) => c.threads(workspaceId)),
  sessionMessages: (threadId: string) => chat((c) => c.sessionMessages(threadId)),
  upsertThread: (input: ChatThreadUpsertInput) => chat((c) => c.upsertThread(input)),
  deleteThread: (threadId: string) => chat((c) => c.deleteThread(threadId)),
  clearThreadMessages: (threadId: string) => chat((c) => c.clearThreadMessages(threadId)),
  clearAllThreads: (workspaceId: string, projectId?: string) =>
    chat((c) => c.clearAllThreads(workspaceId, projectId)),
  compactThread: (req: IpcArgs<"chat:compactThread">[0]) => chat((c) => c.compactThread(req)),
  summarizeTranscript: (req: IpcArgs<"chat:summarizeTranscript">[0]) =>
    chat((c) => c.summarizeTranscript(req)),
  /** Called by main window: sends current chat state, triggers window creation. */
  popOut: (payload: ChatPopoutPayload) => chat((c) => c.popOut(payload)),
  /** Called by pop-out page: signals readiness, returns the shared session id. */
  popoutReady: () => chat((c) => c.popoutReady()),
  /** Called by pop-out page: closes the window; session state is not copied. */
  popIn: (payload: { sessionId: string }) => chat((c) => c.popIn(payload)),
  /** Called by main window: asks the pop-out to return (relayed via main process). */
  requestPopIn: () => chat((c) => c.requestPopIn()),
  /** Listener on the main window: received when pop-in completes with final state. */
  onChatPoppedIn: (cb: (payload: IpcEvents["chat:poppedIn"]) => void): (() => void) =>
    window.electron?.chat?.onChatPoppedIn?.(cb) ?? (() => {}),
  /** Listener on the main window: pop-out closed unexpectedly (e.g. Cmd+W). */
  onChatPoppedOutClosed: (cb: () => void): (() => void) =>
    window.electron?.chat?.onChatPoppedOutClosed?.(cb) ?? (() => {}),
  /** Listener on the pop-out page: received when main window requests pop-in. */
  onChatRequestPopIn: (cb: () => void): (() => void) =>
    window.electron?.chat?.onChatRequestPopIn?.(cb) ?? (() => {}),
  /** Listener on the pop-out page: received when main window pushes an updated session. */
  onChatSessionUpdated: (cb: (payload: ChatPopoutPayload) => void): (() => void) =>
    window.electron?.chat?.onChatSessionUpdated?.(cb) ?? (() => {}),
};
