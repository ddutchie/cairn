import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const { recordMock, state } = vi.hoisted(() => ({ recordMock: vi.fn(), state: { faux: undefined as unknown } }));

vi.mock("../lib/usage-recorder", () => ({ recordLlmUsage: recordMock }));
vi.mock("./provider", async (orig) => {
  const real = await orig<typeof import("./provider")>();
  return {
    ...real,
    createRouteStream: () => {
      const faux = state.faux as ReturnType<typeof fauxProvider>;
      const models = createModels();
      models.setProvider(faux.provider);
      return { model: faux.getModel(), streamFn: (m: never, c: never, o: never) => models.streamSimple(m, c, o) };
    },
  };
});

import { runOneShot } from "./one-shot";

const opts = { systemPrompt: "sys", userPrompt: "user", config: { baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "" }, source: "prd" };
const faux = () => state.faux as ReturnType<typeof fauxProvider>;

describe("runOneShot", () => {
  beforeEach(() => { recordMock.mockReset(); state.faux = fauxProvider(); });

  it("returns the text and records usage under the caller's source", async () => {
    faux().setResponses([fauxAssistantMessage("Hello world")]);
    await expect(runOneShot({ ...opts, projectId: "p1" })).resolves.toBe("Hello world");
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ source: "prd", projectId: "p1", sessionId: "one-shot", model: "m" }));
  });

  it("rejects on an empty completion", async () => {
    faux().setResponses([fauxAssistantMessage("")]);
    await expect(runOneShot(opts)).rejects.toThrow(/empty/i);
  });
});
