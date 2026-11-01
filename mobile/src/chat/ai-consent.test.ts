/** AI provider consent: asked once per remote host, local endpoints exempt. */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Alert: { alert: () => {} } }));
vi.mock("@/db", () => ({ getMeta: () => null, setMeta: () => {} }));

const { ensureAiConsent, isLocalHost, endpointHost, AiConsentDeclinedError } = await import("./ai-consent");

function deps(answer: boolean) {
  const map = new Map<string, string>();
  const ask = vi.fn(async () => answer);
  return { map, ask, get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}

describe("ensureAiConsent", () => {
  it("asks once per host and remembers an Allow", async () => {
    const d = deps(true);
    await ensureAiConsent("https://api.openai.com/v1", d);
    await ensureAiConsent("https://api.openai.com/v1/", d);
    expect(d.ask).toHaveBeenCalledTimes(1);
    await ensureAiConsent("https://openrouter.ai/api/v1", d);
    expect(d.ask).toHaveBeenCalledTimes(2);
  });

  it("throws on Don't allow and asks again next time", async () => {
    const d = deps(false);
    await expect(ensureAiConsent("https://api.openai.com/v1", d)).rejects.toBeInstanceOf(AiConsentDeclinedError);
    await expect(ensureAiConsent("https://api.openai.com/v1", d)).rejects.toBeInstanceOf(AiConsentDeclinedError);
    expect(d.ask).toHaveBeenCalledTimes(2);
  });

  it("never asks for endpoints on this device or the local network", async () => {
    const d = deps(false);
    for (const url of [
      "http://127.0.0.1:8000/v1",
      "http://localhost:3042",
      "http://studio.local:1234/v1",
      "http://192.168.1.20:11434/v1",
      "http://10.0.0.5/v1",
      "http://[::1]:8000/v1",
    ]) {
      await ensureAiConsent(url, d);
    }
    expect(d.ask).not.toHaveBeenCalled();
  });
});

describe("host helpers", () => {
  it("parses hosts and classifies private ranges", () => {
    expect(endpointHost("https://API.example.com/v1")).toBe("api.example.com");
    expect(endpointHost("not a url")).toBeNull();
    expect(isLocalHost("172.20.1.1")).toBe(true);
    expect(isLocalHost("172.40.1.1")).toBe(false);
    expect(isLocalHost("8.8.8.8")).toBe(false);
    expect(isLocalHost("myserver")).toBe(true);
  });
});
