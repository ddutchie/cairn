import { describe, it, expect, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as React from "react";
import { KeyedSlotOutlet } from "@/lib/plugin-ui/SlotOutlet";
import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "@/lib/plugin-ui/api";
import type { ToolCallViewProps } from "@/lib/dsh-toolview/contract";
import { esmToCjsForTest } from "@/lib/plugin-ui/loader";
// Simulates the loader's CJS require() table for the real dsh-visualize
// bundle shape; require() is unavoidable here.
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * dsh-visualize spike: the community plugin's UI SHAPE runs in Cairn —
 * { name, inject:['slots'], apply(ctx) } calling ctx.slots.register through the
 * dsh-client ctx shim. The inlined source below is the authentic shape the real
 * bundle uses (ESM exports + require("react") + ctx.slots.inject → register of
 * a keyed tool.call.toolview rendering a sandboxed iframe). We eval it exactly
 * as the loader does (ESM→CJS transpile + platform require), activate it, and
 * render a `visualize` tool call — asserting the iframe carries the model's
 * HTML. No dsh shell involved.
 *
 * The REAL dsh-visualize is installed via Settings → Plugins
 * (github:Nagi-ovo/dsh-visualize) — this test guards the shim it relies on.
 */

// Eval the plugin source the way the loader does (transpile ESM, resolve the
// platform module table for require('react')).
function evalPlugin(source: string): UIPluginModule {
  const platform: Record<string, unknown> = { react: React, "react/jsx-runtime": require("react/jsx-runtime") };
  const src = /(^|[\n;])\s*export\s|(^|[\n;])\s*import\s.+\sfrom\s/m.test(source) ? esmToCjsForTest(source) : source;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (n: string) => { if (n in platform) return platform[n]; throw new Error(`require(${n})`); };
   
  new Function("module", "exports", "require", src)(mod, mod.exports, req);
  const raw = mod.exports;
  return (raw.activate || raw.apply ? raw : raw.default) as UIPluginModule;
}

const DSH_SHAPED_PLUGIN = `
const HEIGHT_MSG = "cairn-visualize-height";
function readHtml(block) {
  if (block && "kind" in block && Array.isArray(block.content)) {
    for (const b of block.content) if (b.type === "text" && b.text) return b.text;
  }
  return null;
}
const React = require("react");
function VisualizeCard(props) {
  const html = readHtml(props.block);
  if (!html) return React.createElement("div", { style: { fontSize: 12 } }, "\\u2728 rendering visualization\\u2026");
  return React.createElement(
    "div",
    null,
    React.createElement("div", null, "\\u2728 Visualization"),
    React.createElement("iframe", {
      sandbox: "allow-scripts",
      srcDoc: "<!doctype html><html><body>" + html + "</body></html>",
      style: { display: "block", width: "100%", border: 0 },
    }),
  );
}
export const name = "dsh-visualize";
export const inject = ["slots"];
export function apply(ctx) {
  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register({ name: "tool.call.toolview", key: "visualize" }, VisualizeCard),
  );
}
`;

function settledVisualizeCall(html: string): ToolCallViewProps {
  return {
    callId: "viz-1",
    toolName: "visualize",
    block: {
      kind: "tool-result", seq: 0, time: 0, callId: "viz-1",
      call: { name: "visualize", argsRaw: JSON.stringify({ html }) },
      callTime: 0, content: [{ type: "text", text: html }], isError: false,
      callView: null, resultView: null, subCalls: [],
    },
    openFile: () => {},
  };
}

describe("dsh-visualize spike (community-plugin UI shape in Cairn)", () => {
  afterEach(() => { for (const id of activeUIPluginIds()) deactivateUIPlugin(id); });

  it("loads the dsh-shaped toolview and renders the HTML in a sandboxed iframe", () => {
    act(() => activateUIPlugin("dsh-visualize", evalPlugin(DSH_SHAPED_PLUGIN)));

    const html = "<h1>Hello viz</h1><p>interactive</p>";
    const { container } = render(
      <KeyedSlotOutlet name="tool.call.toolview" matchKey="visualize" props={settledVisualizeCall(html)} />,
    );

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    // Sandboxed, script-only (cannot touch the host) — the dsh-visualize contract.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    // The model's HTML is carried into the frame document.
    expect(iframe.getAttribute("srcdoc")).toContain("Hello viz");
    expect(iframe.getAttribute("srcdoc")).toContain("interactive");
  });

  it("shows a running state before the result settles", () => {
    act(() => activateUIPlugin("dsh-visualize", evalPlugin(DSH_SHAPED_PLUGIN)));
    const running: ToolCallViewProps = {
      callId: "v", toolName: "visualize",
      block: { callId: "v", name: "visualize", argsRaw: "", turn: 0, step: 0, time: 0, callView: null, subCalls: [] },
      openFile: () => {},
    };
    const { container } = render(<KeyedSlotOutlet name="tool.call.toolview" matchKey="visualize" props={running} />);
    expect(container.textContent).toContain("rendering visualization");
  });

  it("routes a PERSISTED (reloaded) tool-call record to the toolview, not the generic chip", async () => {
    // Both the live (ToolCallIndicator) and reloaded (ChatMessageBubble) paths
    // dispatch through the same plugin-ui slot + adapter. Persisted records lack
    // `status`; the bubble maps them to status:"done". Prove the adapter builds a
    // settled block that renders the card.
    act(() => activateUIPlugin("dsh-visualize", evalPlugin(DSH_SHAPED_PLUGIN)));
    const { toToolCallViewProps } = await import("@/lib/dsh-toolview/adapter");
    const record = { tool: "visualize", label: "visualize", callId: "p1", args: "{}", output: "<b>persisted viz</b>", ok: true, status: "done" as const };
    const { container } = render(
      <KeyedSlotOutlet name="tool.call.toolview" matchKey="visualize" props={toToolCallViewProps(record)} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute("srcdoc")).toContain("persisted viz");
  });
});
