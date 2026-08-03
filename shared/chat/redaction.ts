const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)/i;
const SENSITIVE_ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*)(["']?)[^\s,;&"']+\2/gi;
const AUTHORIZATION_ASSIGNMENT = /(authorization\s*[:=]\s*)(["']?)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;&"']+\2/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, "$1$2[redacted]$2")
    .replace(AUTHORIZATION_ASSIGNMENT, "$1$2[redacted]$2");
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
  }
  return value;
}
