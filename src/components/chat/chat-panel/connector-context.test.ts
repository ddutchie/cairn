import { describe, expect, it } from "vitest";
import { connectorForTool, parseToolArgs } from "./connector-context";

describe("chat connector context", () => {
  it("parses valid JSON arguments and safely ignores malformed values", () => {
    expect(parseToolArgs('{"query":"retry"}')).toEqual({ query: "retry" });
    expect(parseToolArgs("not json")).toEqual({});
    expect(parseToolArgs("[]")).toEqual({});
  });

  it("resolves an installed connector by its namespaced tool prefix", () => {
    const connector = { name: "Slack", kind: "service" as const };
    expect(connectorForTool("svc__service-1__post_message", { "svc__service-1__": connector })).toBe(connector);
    expect(connectorForTool("read", { "svc__service-1__": connector })).toBeUndefined();
  });
});
