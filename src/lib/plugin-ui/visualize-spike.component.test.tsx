import { describe, it, expect, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { KeyedSlotOutlet } from "@/lib/plugin-ui/SlotOutlet";
import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "@/lib/plugin-ui/api";
import type { ToolCallViewProps } from "@/lib/dsh-toolview/contract";

/**
 * Phase 2 spike: the community plugin dsh-visualize's UI SHAPE runs in Cairn.
 * We load the shipped visualize-view.plugin.js exactly as the renderer loader
 * does (new Function CJS eval), activate it, and render a `visualize` tool call
 * through the tool.call.toolview slot — asserting the sandboxed iframe carries
 * the model's HTML. No dsh shell involved.
 */

/**
 * Phase 2 spike: the community plugin dsh-visualize's AUTHENTIC shape runs in
 * Cairn — { name, inject, apply(ctx) } calling ctx.slots.register, driven via
 * the dsh-client ctx shim. We eval the shipped file exactly as the loader does
 * (ESM→CJS transpile + platform require), activate it, and render a `visualize`
 * tool call through the tool.call.toolview slot — asserting the sandboxed iframe
 * carries the model's HTML. No dsh shell involved.
 */

import { esmToCjsForTest } from "@/lib/plugin-ui/loader";

// Eval the plugin source the way the loader does (transpile ESM, resolve the
// platform module table for require('react')).
function evalPlugin(source: string): UIPluginModule {
  const platform: Record<string, unknown> = { react: React, "react/jsx-runtime": require("react/jsx-runtime") };
  const src = /(^|[\n;])\s*export\s|(^|[\n;])\s*import\s.+\sfrom\s/m.test(source) ? esmToCjsForTest(source) : source;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (n: string) => { if (n in platform) return platform[n]; throw new Error(`require(${n})`); };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "require", src)(mod, mod.exports, req);
  const raw = mod.exports;
  return (raw.activate || raw.apply ? raw : raw.default) as UIPluginModule;
}

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

  it("loads the shipped visualize toolview and renders the HTML in a sandboxed iframe", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../electron/cordis/plugins-template/visualize-view.plugin.js"),
      "utf8",
    );
    act(() => activateUIPlugin("visualize", evalPlugin(src)));

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
    const src = fs.readFileSync(
      path.join(__dirname, "../../../electron/cordis/plugins-template/visualize-view.plugin.js"),
      "utf8",
    );
    act(() => activateUIPlugin("visualize", evalPlugin(src)));
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
    const src = fs.readFileSync(
      path.join(__dirname, "../../../electron/cordis/plugins-template/visualize-view.plugin.js"),
      "utf8",
    );
    act(() => activateUIPlugin("visualize", evalPlugin(src)));
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
