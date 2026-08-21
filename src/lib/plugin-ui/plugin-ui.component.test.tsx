import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import * as React from "react";
import { AppOverlayLayer } from "./SlotOutlet";
import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "./api";
import { SLOT_MATRIX, ALL_SLOTS } from "./slot-matrix";

/**
 * Cairn plugin-UI system: a UI plugin activates against the ui API, registers a
 * component into a declared slot, and Cairn's SlotOutlet renders it live —
 * deactivating removes it. This proves plugin-drawn chrome (e.g. a bouncing cat)
 * beyond the toolview embed, without the dsh shell.
 */

const overlayProps = { activeView: "notes" as const, activeProjectId: "p1" };

// A minimal UI plugin module (what the renderer loader evaluates from source).
function catPlugin(): UIPluginModule {
  return {
    activate(ui) {
      const { React: R } = ui;
      const Cat = () => R.createElement("div", { "data-testid": "cat", style: { pointerEvents: "auto" } }, "\uD83D\uDC08");
      ui.registerOverlay("bouncing-cat", Cat);
    },
  };
}

describe("plugin-ui slot system", () => {
  afterEach(() => { for (const id of activeUIPluginIds()) deactivateUIPlugin(id); });

  it("declares the expected slot matrix", () => {
    expect(ALL_SLOTS).toContain("app.overlay");
    expect(ALL_SLOTS).toContain("app.statusbar");
    expect(ALL_SLOTS).toContain("tool.call.toolview");
    expect(SLOT_MATRIX["app.overlay"]).toMatchObject({ kind: "list", scope: "app" });
    expect(SLOT_MATRIX["tool.call.toolview"]).toMatchObject({ kind: "keyed", scope: "turn" });
  });

  it("renders a plugin-registered overlay component, click-through by default", () => {
    const { container } = render(<AppOverlayLayer {...overlayProps} />);
    // Nothing until a plugin registers.
    expect(screen.queryByTestId("cat")).toBeNull();

    act(() => activateUIPlugin("cat", catPlugin()));
    expect(screen.getByTestId("cat")).toBeTruthy();

    // The overlay layer itself is click-through (pointer-events:none); the entry
    // opts back in.
    const layer = container.querySelector("[data-app-overlay]") as HTMLElement;
    expect(layer.style.pointerEvents).toBe("none");
  });

  it("removes the component when the plugin is deactivated (live unload)", () => {
    render(<AppOverlayLayer {...overlayProps} />);
    act(() => activateUIPlugin("cat", catPlugin()));
    expect(screen.getByTestId("cat")).toBeTruthy();
    act(() => deactivateUIPlugin("cat"));
    expect(screen.queryByTestId("cat")).toBeNull();
  });

  it("re-activating a plugin id refreshes its registrations (no dupes)", () => {
    render(<AppOverlayLayer {...overlayProps} />);
    act(() => activateUIPlugin("cat", catPlugin()));
    act(() => activateUIPlugin("cat", catPlugin())); // e.g. after a live edit
    expect(screen.getAllByTestId("cat")).toHaveLength(1);
  });

  it("isolates a crashing plugin component (does not take down the app)", () => {
    const bad: UIPluginModule = {
      activate(ui) {
        const Boom = () => { throw new Error("plugin boom"); };
        ui.registerOverlay("boom", Boom);
        const Ok = () => ui.React.createElement("div", { "data-testid": "ok" }, "ok");
        ui.registerOverlay("ok", Ok);
      },
    };
    render(<AppOverlayLayer {...overlayProps} />);
    act(() => activateUIPlugin("mixed", bad));
    // The good sibling still renders; the boom one is swallowed by the boundary.
    expect(screen.getByTestId("ok")).toBeTruthy();
  });
});
