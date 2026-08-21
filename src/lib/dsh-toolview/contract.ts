/**
 * §11 toolview micro-host — the dsh ToolCallViewProps contract, vendored.
 *
 * This is the DATA CONTRACT a dsh `tool.call.toolview` React component receives
 * (from scratch/dsh-repo/packages/client/ui-tool/src/client/contract/slots.ts:29
 * + runtime/src/client/sessions/conversation.ts:185/295). We reproduce ONLY the
 * shapes a pure, replay-stable toolview reads — no session store, no connection.
 *
 * The point of the spike: prove a real dsh toolview component renders inside
 * Cairn's own transcript when handed a Cairn-built ToolCallViewProps — WITHOUT
 * adopting the dsh web shell (ui-layout/ui-conversation/connection).
 */

/** dsh ContentBlock — only the text case matters for a pure toolview row. */
export type DshContentBlock =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

/** In-flight tool card material: tool/call seen, tool/result not yet. */
export interface RunningToolCall {
  callId: string;
  name: string;
  argsRaw: string;
  turn: number;
  step: number;
  time: number;
  callView: null;
  subCalls: readonly ToolCallBlock[];
}

/** Settled tool result (the `'kind' in block` branch dsh views test). */
export interface ToolResultNode {
  kind: "tool-result";
  seq: number;
  time: number;
  callId: string;
  call: { name: string; argsRaw: string } | null;
  callTime: number | null;
  content: readonly DshContentBlock[];
  isError: boolean;
  error?: { name: string; code: string };
  callView: null;
  resultView: null;
  subCalls: readonly ToolCallBlock[];
}

export type ToolCallBlock = RunningToolCall | ToolResultNode;

/** Standard owner currency supplied to every atomic Tool view (ui-tool slots.ts:29). */
export interface ToolCallViewProps {
  callId: string;
  toolName: string;
  block: ToolCallBlock;
  cwd?: string | undefined;
  home?: string | undefined;
  openFile: (path: string) => void;
  inspect?: (() => void) | undefined;
}
