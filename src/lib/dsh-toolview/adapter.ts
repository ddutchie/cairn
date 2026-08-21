/**
 * Adapter: Cairn's ChatToolCall  →  dsh ToolCallViewProps.
 *
 * This is the seam that lets a dsh toolview render in Cairn's transcript. Cairn
 * already tracks everything a pure toolview needs (tool name, raw args, output,
 * ok/error, running-vs-done) on ChatToolCall — we just reshape it into dsh's
 * RunningToolCall (streaming) / ToolResultNode (settled) block union.
 */
import type { ChatToolCall } from "@/hooks/useChatStream";
import type { ToolCallViewProps, ToolCallBlock, RunningToolCall, ToolResultNode } from "./contract";

/** Build the dsh `block` union from a Cairn tool call. */
export function toDshBlock(tc: ChatToolCall): ToolCallBlock {
  const callId = tc.callId ?? tc.tool;
  const argsRaw = tc.args ?? "";
  const now = Date.now();
  if (tc.status === "running") {
    const running: RunningToolCall = {
      callId,
      name: tc.tool,
      argsRaw,
      turn: 0,
      step: 0,
      time: now,
      callView: null,
      subCalls: [],
    };
    return running;
  }
  const settled: ToolResultNode = {
    kind: "tool-result",
    seq: 0,
    time: now,
    callId,
    call: { name: tc.tool, argsRaw },
    callTime: now,
    content: tc.output != null && tc.output !== "" ? [{ type: "text", text: tc.output }] : [],
    isError: tc.ok === false,
    ...(tc.ok === false ? { error: { name: "ToolError", code: tc.error ?? "error" } } : {}),
    callView: null,
    resultView: null,
    subCalls: [],
  };
  return settled;
}

/** Full ToolCallViewProps for a Cairn tool call (host callbacks are Cairn-wired). */
export function toToolCallViewProps(
  tc: ChatToolCall,
  opts?: { cwd?: string; home?: string; openFile?: (p: string) => void; inspect?: () => void },
): ToolCallViewProps {
  return {
    callId: tc.callId ?? tc.tool,
    toolName: tc.tool,
    block: toDshBlock(tc),
    cwd: opts?.cwd,
    home: opts?.home,
    openFile: opts?.openFile ?? (() => {}),
    inspect: opts?.inspect,
  };
}
