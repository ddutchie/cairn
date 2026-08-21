import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import * as React from "react";
import { AppOverlayLayer, AppStatusBar } from "./SlotOutlet";import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "./api";
import { SLOT_MATRIX, ALL_SLOTS } from "./slot-matrix";
import { resolveSlotName, DSH_SLOT_ALIAS, dshCompatSummary } from "./dsh-slot-map";

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

  it("aliases dsh slot names onto Cairn slots (shell.overlay -> app.overlay)", () => {
    // A dsh-shaped plugin that registers by the DSH slot name.
    const dshPlugin: UIPluginModule = {
      activate(ui) {
        const Cat = () => ui.React.createElement("div", { "data-testid": "dsh-cat" }, "\uD83D\uDC08");
        ui.registerBySlot("shell.overlay", { id: "cat" }, Cat);
      },
    };
    render(<AppOverlayLayer {...overlayProps} />);
    act(() => activateUIPlugin("dsh-cat", dshPlugin));
    expect(screen.getByTestId("dsh-cat")).toBeTruthy();
  });

  it("resolves slot names via the alias map (dsh + native), rejects shell-only", () => {
    expect(resolveSlotName("shell.overlay")).toBe("app.overlay");
    expect(resolveSlotName("tool.call.toolview")).toBe("tool.call.toolview"); // same name
    expect(resolveSlotName("conversation.composer.dock")).toBe("chat.transcript.footer");
    expect(resolveSlotName("app.overlay")).toBe("app.overlay"); // native passthrough
    expect(resolveSlotName("conversation.session")).toBeNull(); // shell-only
    expect(resolveSlotName("root")).toBeNull(); // would erase the app
    expect(resolveSlotName("nonsense.slot")).toBeNull();
    // The alias map only contains 'aliased' entries.
    expect(DSH_SLOT_ALIAS["shell.overlay"]).toBe("app.overlay");
    expect(DSH_SLOT_ALIAS["conversation.session"]).toBeUndefined();
  });

  it("skips (with a warning) a dsh plugin targeting a shell-only slot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shellPlugin: UIPluginModule = {
      activate(ui) {
        const C = () => ui.React.createElement("div", { "data-testid": "should-not-render" });
        ui.registerBySlot("conversation.session", { id: "x" }, C);
      },
    };
    render(<AppOverlayLayer {...overlayProps} />);
    act(() => activateUIPlugin("shell-plugin", shellPlugin));
    expect(screen.queryByTestId("should-not-render")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dsh compat summary counts every dsh slot", () => {
    const s = dshCompatSummary();
    const total = s.aliased + s["cairn-has-different"] + s["shell-only"] + s.planned;
    expect(total).toBeGreaterThanOrEqual(30); // full production inventory
    expect(s.aliased).toBeGreaterThanOrEqual(4); // shell.overlay, tool.call.toolview, composer.dock, sidebar.footer.action, settings.section
  });

  it("renders a status-bar plugin item, and the bar hides when empty", () => {
    const { container, rerender } = render(<AppStatusBar {...overlayProps} />);
    // Empty → the bar renders nothing (layout unaffected).
    expect(container.querySelector("[data-app-statusbar]")).toBeNull();

    const clock: UIPluginModule = {
      activate(ui) {
        const Clock = () => ui.React.createElement("span", { "data-testid": "clock" }, "12:00");
        ui.registerStatusBarItem("clock", Clock);
      },
    };
    act(() => activateUIPlugin("clock", clock));
    rerender(<AppStatusBar {...overlayProps} />);
    expect(screen.getByTestId("clock")).toBeTruthy();
    expect(container.querySelector("[data-app-statusbar]")).toBeTruthy();
  });
});
