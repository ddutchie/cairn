import { redactSensitiveText, redactValue } from "../../shared/chat/redaction";

export { redactSensitiveText } from "../../shared/chat/redaction";
const MAX_TOOL_OUTPUT_LENGTH = 8_000;

export function redactToolOutput(value: string | undefined): string | undefined {
  if (!value) return value;
  let redacted: string;
  try {
    const parsed = JSON.parse(value);
    redacted = parsed && typeof parsed === "object"
      ? JSON.stringify(redactTranscriptValue(parsed))
      : redactSensitiveText(value);
  } catch {
    redacted = redactSensitiveText(value);
  }
  return redacted.slice(0, MAX_TOOL_OUTPUT_LENGTH);
}

export function prettyToolOutput(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2).slice(0, MAX_TOOL_OUTPUT_LENGTH);
  } catch {
    return value.slice(0, MAX_TOOL_OUTPUT_LENGTH);
  }
}

export function redactTranscriptValue(value: unknown, key?: string): unknown {
  return redactValue(value, key);
}

export function redactAgentToolCall<T extends { args?: Record<string, unknown>; output?: string }>(toolCall: T): T {
  return {
    ...toolCall,
    args: toolCall.args ? redactTranscriptValue(toolCall.args) as Record<string, unknown> : toolCall.args,
    output: redactToolOutput(toolCall.output),
  };
}
