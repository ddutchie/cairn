import { redactValue } from "@cairn/shared/chat/redaction";

const MAX_TOOL_OUTPUT_LENGTH = 8_000;

export function safeToolOutput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string"
    ? redactValue(value) as string
    : (JSON.stringify(redactValue(value)) ?? "");
  return text.slice(0, MAX_TOOL_OUTPUT_LENGTH);
}

export function prettyToolOutput(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2).slice(0, MAX_TOOL_OUTPUT_LENGTH);
  } catch {
    return value.slice(0, MAX_TOOL_OUTPUT_LENGTH);
  }
}
