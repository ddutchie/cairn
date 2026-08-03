const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)/i;
const SENSITIVE_ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*[:=]\s*)([^\s,;&]+)/gi;

export function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_ASSIGNMENT, "$1[redacted]");
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
    output: toolCall.output ? redactSensitiveText(toolCall.output) : toolCall.output,
  };
}
