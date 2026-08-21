import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AppOverlayLayer } from "./SlotOutlet";
import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "./api";

/**
 * Loader eval-path coverage: a plugin can be authored as CJS (module.exports +
 * require) OR ESM (export + import). Both must resolve React from the platform
 * module table (one shared instance) and register into a slot. We exercise the
 * same eval logic the renderer loader uses.
 *
 * Note: the loader's Blob-import ESM path needs a DOM/URL environment; here we
 * assert the CJS require-table path (the real dsh-bundle shape) and the ESM
 * SOURCE REWRITE (pure string transform) independently — the full blob import
 * is covered by the live path in the app.
 */

// Re-implement the loader's require table + rewrite for a unit-level check
// without booting the whole startUIPlugins() electron flow.
const overlayProps = { activeView: "notes" as const, activeProjectId: null };

function evalCjs(source: string, React: typeof import("react")): UIPluginModule {
  const platform: Record<string, unknown> = { react: React, "react/jsx-runtime": require("react/jsx-runtime") };
  const mod = { exports: {} as Record<string, unknown> };
  const req = (n: string) => { if (n in platform) return platform[n]; throw new Error(`require(${n})`); };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "require", "React", source)(mod, mod.exports, req, React);
  return (mod.exports.activate ? mod.exports : mod.exports.default) as UIPluginModule;
}

describe("plugin-ui loader eval paths", () => {
  afterEach(() => { for (const id of activeUIPluginIds()) deactivateUIPlugin(id); });

  it("loads a CJS plugin that require()s react (the real dsh-bundle shape)", async () => {
    const React = await import("react");
    // A dsh-style CJS bundle: pulls React from the platform table via require.
    const src = `
      const R = require("react");
      const { jsx } = require("react/jsx-runtime");
      function activate(ui) {
        const Badge = () => R.createElement("div", { "data-testid": "cjs-badge" }, "cjs-ok");
        ui.registerOverlay("badge", Badge);
      }
      module.exports = { activate };
    `;
    act(() => activateUIPlugin("cjs", evalCjs(src, React)));
    render(<AppOverlayLayer {...overlayProps} />);
    expect(screen.getByTestId("cjs-badge")).toBeTruthy();
  });

  it("transpiles ESM (import/export) to CJS runnable through the require table", async () => {
    const React = await import("react");
    const { esmToCjsForTest } = await import("./loader");
    const esm = `import { createElement } from "react";\nexport function activate(ui) {\n  ui.registerOverlay("esm", () => createElement("div", { "data-testid": "esm-badge" }, "esm-ok"));\n}`;
    const cjs = esmToCjsForTest(esm);
    // No ESM syntax remains; imports became require, export became exports.
    expect(cjs).not.toMatch(/^\s*import\s/m);
    expect(cjs).toContain('require("react")');
    expect(cjs).toContain("exports[\"activate\"]");
    // And it actually runs + registers through the same CJS path.
    act(() => activateUIPlugin("esm", evalCjs(cjs, React)));
    render(<AppOverlayLayer {...overlayProps} />);
    expect(screen.getByTestId("esm-badge")).toBeTruthy();
  });

  it("loads a real dsh bundle wrapped in window.__ModuleLoader__.load({ factory }) exporting apply(ctx)", async () => {
    const { evalPluginModuleForTest } = await import("./loader");
    // The exact shape tsdown emits for a dsh client plugin: the CJS body lives
    // inside a factory registered with a global __ModuleLoader__, and exports
    // apply/inject/name — driven via the dsh ctx shim (apply path).
    const wrapped = `
      window.__ModuleLoader__.load({
        id: "@dsh-external/example",
        factory: (require) => {
          var module = { exports: {} };
          var exports = module.exports;
          var react = require("react");
          function VizCard() { return react.createElement("div", { "data-testid": "wrapped-viz" }, "viz"); }
          function apply(ctx) {
            ctx.slots.inject("tool.call.toolview", () =>
              ctx.slots.register({ name: "tool.call.toolview", key: "visualize" }, VizCard));
          }
          exports.apply = apply;
          exports.inject = ["slots"];
          exports.name = "example";
          return module.exports;
        }
      });
    `;
    const mod = evalPluginModuleForTest("wrapped", wrapped);
    expect(mod).toBeTruthy();
    expect(typeof (mod as { apply?: unknown }).apply).toBe("function");
    // Activating routes through the dsh ctx shim → registers the keyed toolview.
    act(() => activateUIPlugin("wrapped", mod!));
    const { slotHasKey } = await import("./registry");
    expect(slotHasKey("tool.call.toolview", "visualize")).toBe(true);
  });
});
