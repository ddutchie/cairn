import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactValue } from "./redaction";

describe("redact sensitive assignments", () => {
  it("redacts every sensitive key represented by SENSITIVE_KEY", () => {
    const input = [
      "api_key=1", "api-key=2", "apikey=3",
      "access_token=4", "access-token=5",
      "auth=6", "authorization=7",
      "cookie=8", "credential=9",
      "password=10", "private_key=11", "private-key=12", "privatekey=13",
      "secret=14", "token=15",
    ].join(" ");
    expect(redactSensitiveText(input)).toBe([
      "api_key=[redacted]", "api-key=[redacted]", "apikey=[redacted]",
      "access_token=[redacted]", "access-token=[redacted]",
      "auth=[redacted]", "authorization=[redacted]",
      "cookie=[redacted]", "credential=[redacted]",
      "password=[redacted]", "private_key=[redacted]", "private-key=[redacted]", "privatekey=[redacted]",
      "secret=[redacted]", "token=[redacted]",
    ].join(" "));
  });

  it("redacts quoted values while preserving the quotes", () => {
    expect(redactSensitiveText('TOKEN="abc" PASSWORD=\'xyz\'')).toBe('TOKEN="[redacted]" PASSWORD=\'[redacted]\'');
  });

  it("redacts authorization schemes as a whole", () => {
    expect(redactSensitiveText("auth: Basic dXNlcjpwYXNz")).toBe("auth: [redacted]");
    expect(redactSensitiveText("Authorization: abc123")).toBe("Authorization: [redacted]");
  });

  it("fully redacts multi-token PEM values without touching unrelated fields", () => {
    const pem = "PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nNEXT=keep";
    expect(redactSensitiveText(pem)).toBe("PRIVATE_KEY=[redacted]\nNEXT=keep");
  });

  it("fully redacts multi-cookie values without touching unrelated fields", () => {
    expect(redactSensitiveText("COOKIE=a=1; b=2 other=keep")).toBe("COOKIE=[redacted] other=keep");
    expect(redactSensitiveText('Cookie="a=1; b=2"; Path=/')).toBe('Cookie="[redacted]"; Path=/');
  });

  it("leaves single-token cookie values redacted", () => {
    expect(redactSensitiveText("COOKIE=PHPSESSID")).toBe("COOKIE=[redacted]");
  });

  it("redacts sensitive keys inside arbitrary plain-text output", () => {
    expect(redactSensitiveText("set-cookie: a=1; b=2, X-API-Key: def")).toBe(
      "set-cookie: [redacted], X-API-Key: [redacted]"
    );
  });

  it("redacts sensitive keys inside parsed values", () => {
    expect(redactValue({ auth: "Basic abc", cookie: "a=1; b=2" })).toEqual({
      auth: "[redacted]",
      cookie: "[redacted]",
    });
  });
});
