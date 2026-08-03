const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)/i;
const SENSITIVE_ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*)(["']?)[^\s,;&"']+\2/gi;
const AUTHORIZATION_ASSIGNMENT = /(authorization\s*[:=]\s*)(["']?)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;&"']+\2/gi;
const MAX_TOOL_OUTPUT_LENGTH = 8_000;

export function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, "$1$2[redacted]$2")
    .replace(AUTHORIZATION_ASSIGNMENT, "$1$2[redacted]$2");
}

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
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactTranscriptValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactTranscriptValue(entryValue, entryKey)])
    );
  }
  return value;
}

export function redactAgentToolCall<T extends { args?: Record<string, unknown>; output?: string }>(toolCall: T): T {
  return {
    ...toolCall,
    args: toolCall.args ? redactTranscriptValue(toolCall.args) as Record<string, unknown> : toolCall.args,
    output: redactToolOutput(toolCall.output),
  };
}
