/**
 * Every request to a configured provider identifies Cairn: its own User-Agent
 * everywhere, plus a stable `x-opencode-session` for OpenCode, which asks for
 * both (generic HTTP-library agents are treated as abuse). Native modules are
 * mocked so the real provider code runs under plain Node.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  meta: new Map<string, string>(),
}));
vi.mock("expo/fetch", () => ({ fetch: h.fetch }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "9.9.9" } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "session-uuid" }));
vi.mock("@/db", () => ({ getMeta: (k: string) => h.meta.get(k) ?? null, setMeta: (k: string, v: string) => h.meta.set(k, v) }));
vi.mock("../providers-registry", () => ({ fetchProvidersManifest: async () => undefined, getRegistryProviders: () => [] }));
vi.mock("../models-dev", () => ({ contextLimitForModel: async () => 128_000 }));

const { listModels, getKeyInfo, makeOpenAIProvider, providerErrorDetail } = await import("./openai");

const OPENCODE = "https://opencode.ai/zen/go/v1";
const OTHER = "https://api.example.com/v1";

function headersOf(call: unknown[]): Record<string, string> {
  return (call[1] as { headers: Record<string, string> }).headers;
}

beforeEach(() => {
  h.fetch.mockReset();
  h.meta.clear();
});

describe("provider identity headers", () => {
  it("listModels identifies Cairn and sends the OpenCode session", async () => {
    h.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "glm" }] }) });
    await listModels(OPENCODE, "k");
    expect(headersOf(h.fetch.mock.calls[0])).toMatchObject({ "User-Agent": "cairn/9.9.9", "x-opencode-session": "session-uuid" });
  });

  it("getKeyInfo identifies Cairn", async () => {
    h.fetch.mockResolvedValue({ ok: false });
    await getKeyInfo(OPENCODE, "k");
    expect(headersOf(h.fetch.mock.calls[0])).toMatchObject({ "User-Agent": "cairn/9.9.9", "x-opencode-session": "session-uuid" });
  });

  it("chat requests reuse the same session id across turns", async () => {
    const sse = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    const res = () => ({ ok: true, status: 200, body: new Blob([sse]).stream() });
    h.fetch.mockImplementation(async () => res());
    const provider = makeOpenAIProvider({ baseUrl: OPENCODE, model: "glm", apiKey: "k" });
    for (let turn = 0; turn < 2; turn++) {
      for await (const _ of provider.stream([{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }], {})) void _;
    }
    const sessions = h.fetch.mock.calls.map((c) => headersOf(c)["x-opencode-session"]);
    expect(sessions).toEqual(["session-uuid", "session-uuid"]);
    expect(headersOf(h.fetch.mock.calls[0])["User-Agent"]).toBe("cairn/9.9.9");
  });

  it("other providers get the User-Agent but no OpenCode session", async () => {
    h.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await listModels(OTHER, "k");
    const headers = headersOf(h.fetch.mock.calls[0]);
    expect(headers["User-Agent"]).toBe("cairn/9.9.9");
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("providerErrorDetail", () => {
  it("includes the provider's own message so a 400 is diagnosable", async () => {
    const res = { ok: false, status: 400, text: async () => '{"error":{"message":"Invalid schema for function \'delete\'"}}' };
    expect(await providerErrorDetail(res)).toBe("HTTP 400: Invalid schema for function 'delete'");
  });

  it("falls back to the raw body, then to the bare status", async () => {
    expect(await providerErrorDetail({ ok: false, status: 502, text: async () => "Bad gateway\n" })).toBe("HTTP 502: Bad gateway");
    expect(await providerErrorDetail({ ok: false, status: 500, text: async () => { throw new Error("x"); } })).toBe("HTTP 500");
  });
});
