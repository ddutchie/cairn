import { redactSensitiveText, redactValue } from "../../shared/chat/redaction";

export { redactSensitiveText } from "../../shared/chat/redaction";
const MAX_TOOL_OUTPUT_LENGTH = 8_000;

export function redactToolOutput(value: string | undefined): string | undefined {
  if (!value) return value;
  const bounded = value.length > MAX_TOOL_OUTPUT_LENGTH ? value.slice(0, MAX_TOOL_OUTPUT_LENGTH) : value;
  let redacted: string;
  try {
    const parsed = JSON.parse(bounded);
    redacted = parsed && typeof parsed === "object"
      ? JSON.stringify(redactTranscriptValue(parsed))
      : redactSensitiveText(bounded);
  } catch {
    redacted = redactSensitiveText(bounded);
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

export function redactAgentToolCall<T extends object>(toolCall: T & { args?: unknown; output?: string; error?: string }): T & { args?: unknown; output?: string; error?: string } {
  return {
    ...toolCall,
    args: toolCall.args ? redactTranscriptValue(toolCall.args as Record<string, unknown>) : toolCall.args,
    output: redactToolOutput(toolCall.output),
    error: toolCall.error ? redactSensitiveText(toolCall.error) : toolCall.error,
  };
}
