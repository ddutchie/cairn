import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginsSettings } from "./PluginsSettings";

/**
 * Plugins settings section: lists manifest entries, toggles enable/disable
 * (writes plugins.yml via IPC), opens the plugins folder, and shows the
 * dev-preview banner when CAIRN_PLUGINS_DEV is off. Pure UI over a mocked
 * window.electron.plugins surface.
 */

type PluginRow = { id: string; kind: "ui" | "backend" | "both"; name: string | null; ui: string | null; disabled: boolean };

function mockPlugins(initial: { devEnabled: boolean; plugins: PluginRow[] }) {
  let state = structuredClone(initial);
  const setEnabled = vi.fn(async (id: string, enabled: boolean) => {
    const r = state.plugins.find((p) => p.id === id);
    if (r) r.disabled = !enabled;
    return { ok: true };
  });
  const openFolder = vi.fn(async () => ({ ok: true }));
  const api = {
    list: vi.fn(async () => ({ devEnabled: state.devEnabled, root: "/tmp/plugins", plugins: state.plugins })),
    setEnabled,
    openFolder,
    onUiChanged: (_cb: () => void) => () => {},
  };
  (window as unknown as { electron: { plugins: typeof api } }).electron = { plugins: api };
  return { api, setEnabled, openFolder };
}

describe("PluginsSettings", () => {
  beforeEach(() => { delete (window as unknown as { electron?: unknown }).electron; });
  afterEach(() => { delete (window as unknown as { electron?: unknown }).electron; });

  it("lists plugins with kind labels and enabled state", async () => {
    mockPlugins({ devEnabled: true, plugins: [
      { id: "bouncing-cat", kind: "ui", name: null, ui: "./bouncing-cat.plugin.js", disabled: false },
      { id: "hello-tool", kind: "backend", name: "./hello-tool.mjs", ui: null, disabled: true },
    ] });
    render(<PluginsSettings />);
    expect(await screen.findByText("bouncing-cat")).toBeTruthy();
    expect(screen.getByText("hello-tool")).toBeTruthy();
    expect(screen.getByText("UI")).toBeTruthy();
    expect(screen.getByText("Tool")).toBeTruthy();
  });

  it("toggles a plugin (writes via setEnabled)", async () => {
    const { setEnabled } = mockPlugins({ devEnabled: true, plugins: [
      { id: "hello-tool", kind: "backend", name: "./hello-tool.mjs", ui: null, disabled: true },
    ] });
    render(<PluginsSettings />);
    const toggle = await screen.findByRole("switch");
    await act(async () => { await userEvent.click(toggle); });
    // was disabled=true → enable → setEnabled(id, true)
    expect(setEnabled).toHaveBeenCalledWith("hello-tool", true);
  });

  it("opens the plugins folder", async () => {
    const { openFolder } = mockPlugins({ devEnabled: true, plugins: [] });
    render(<PluginsSettings />);
    const btn = await screen.findByText("Open plugins folder");
    await act(async () => { await userEvent.click(btn); });
    expect(openFolder).toHaveBeenCalled();
  });

  it("shows the developer-preview banner when dev is off", async () => {
    mockPlugins({ devEnabled: false, plugins: [] });
    render(<PluginsSettings />);
    await waitFor(() => expect(screen.getByText(/developer preview/i)).toBeTruthy());
    expect(screen.getByText(/CAIRN_PLUGINS_DEV=1/)).toBeTruthy();
  });

  it("shows an empty state when there are no plugins", async () => {
    mockPlugins({ devEnabled: true, plugins: [] });
    render(<PluginsSettings />);
    expect(await screen.findByText("No plugins yet")).toBeTruthy();
  });

  it("signposts the coming plugin agent", async () => {
    mockPlugins({ devEnabled: true, plugins: [] });
    render(<PluginsSettings />);
    expect(await screen.findByText(/Plugin agent/i)).toBeTruthy();
  });
});
