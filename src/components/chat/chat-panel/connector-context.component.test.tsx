import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const state = {
  activeWorkspaceId: "ws",
  mcpServers: [
    { id: "workiq", name: "workiq", communityId: undefined },
    { id: "lin", name: "linear", communityId: "linear" },
  ],
  customServices: [],
};

vi.mock("@/store", () => ({ useCairnStore: (sel: (s: typeof state) => unknown) => sel(state) }));
vi.mock("@/lib/ipc/registry", () => ({
  registryClient: {
    fetch: vi.fn(async () => ({
      manifest: { services: [], mcpServers: [{ id: "linear", iconSvg: "<svg/>", brandColor: "#5E6AD2", definition: { name: "Linear" } }] },
    })),
  },
}));

import { useCommunityConnectorMap } from "./connector-context";

describe("useCommunityConnectorMap", () => {
  it("gives a locally configured server a connector entry even without a registry match", async () => {
    const { result } = renderHook(() => useCommunityConnectorMap());
    // Immediately (registry not loaded yet) every configured server is already mapped.
    expect(result.current["mcp__workiq__"]).toMatchObject({ name: "workiq", kind: "mcp", label: undefined });
    await waitFor(() => expect(result.current["mcp__lin__"]?.label).toBe("Linear"));
    expect(result.current["mcp__workiq__"]).toMatchObject({ name: "workiq", kind: "mcp", iconSvg: undefined });
    expect(result.current["mcp__lin__"]).toMatchObject({ iconSvg: "<svg/>", brandColor: "#5E6AD2" });
  });
});
