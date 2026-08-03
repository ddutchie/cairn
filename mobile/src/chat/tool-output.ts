const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)/i;
const SENSITIVE_ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*)(["']?)[^\s,;&"']+\2/gi;
const AUTHORIZATION_ASSIGNMENT = /(authorization\s*[:=]\s*)(["']?)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;&"']+\2/gi;
const MAX_TOOL_OUTPUT_LENGTH = 8_000;

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value
      .replace(SENSITIVE_ASSIGNMENT, "$1$2[redacted]$2")
      .replace(AUTHORIZATION_ASSIGNMENT, "$1$2[redacted]$2");
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

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
