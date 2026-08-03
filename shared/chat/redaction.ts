const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)/i;
const SENSITIVE_ASSIGNMENT = /(["']?)((api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)["']?\s*[:=]\s*)/gi;

export function redactSensitiveText(value: string): string {
  let result = "";
  let cursor = 0;
  const regex = SENSITIVE_ASSIGNMENT;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const prefix = match[0];
    const key = match[3];
    const valueStart = match.index + prefix.length;
    const valueEnd = consumeSensitiveValue(value, valueStart, key);
    if (valueEnd > valueStart) {
      const quote = value[valueStart] === '"' || value[valueStart] === "'" ? value[valueStart] : "";
      result += value.slice(cursor, match.index) + prefix + quote + "[redacted]" + quote;
      cursor = valueEnd;
      regex.lastIndex = valueEnd;
    } else {
      result += value.slice(cursor, match.index) + prefix;
      cursor = valueStart;
      regex.lastIndex = valueStart + 1;
    }
  }
  result += value.slice(cursor);
  return result;
}

function consumeSensitiveValue(text: string, start: number, key: string): number {
  const rest = text.slice(start);
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
  if (quote) {
    const close = text.indexOf(quote, start + 1);
    return close === -1 ? text.length : close + 1;
  }
  if (rest.startsWith("-----BEGIN")) {
    const end = text.indexOf("-----END", start);
    if (end === -1) {
      // no END marker — fall through to plain token matching to stay bounded
    } else {
      const close = text.indexOf("-----", end + "-----END".length);
      return close === -1 ? text.length : close + "-----".length;
    }
  }
  if (/^auth(?:orization)?$/i.test(key)) {
    const scheme = /^(?:bearer|basic|digest|token|aws4-hmac-sha256)\s+/i.exec(rest);
    if (scheme) {
      const tokenStart = start + scheme[0].length;
      const token = /^[^\s,;&"']+/.exec(text.slice(tokenStart));
      return token ? tokenStart + token[0].length : start;
    }
  }
  if (/^cookie$/i.test(key)) {
    const cookieEnd = consumeCookieList(text, start);
    if (cookieEnd > start) return cookieEnd;
  }
  const token = /^[^\s,;&"']+/.exec(rest);
  return token ? start + token[0].length : start;
}

function consumeCookieList(text: string, start: number): number {
  let index = start;
  let first = true;
  for (;;) {
    const seg = (first ? /^[^\s,;&"'=]+=[^\s,;&"']*/ : /^\s*;\s*[^\s,;&"'=]+=[^\s,;&"']*/).exec(text.slice(index));
    if (!seg) break;
    index += seg[0].length;
    first = false;
  }
  return index;
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
