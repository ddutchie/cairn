import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPermissionSelect } from "./AgentPermissionSelect";

/**
 * Renderer tests for the permission-preset switcher — no model, no shell.
 * window.electron is faked per test (snapshot + projection subscription +
 * command executor); the tests pin:
 *   - snapshot options render with the current preset selected;
 *   - picking another preset executes `/permission <preset>` through the
 *     existing runtime command path (no new IPC channel);
 *   - the derived `custom` row renders but is not a switch target;
 *   - live `permissions` projections update the selection;
 *   - an unavailable service (ok:false snapshot) hides the switcher.
 */

const SELECT = {
  options: [
    { value: "workspace-write", name: "workspace-write", description: "Write inside the workspace." },
    { value: "danger-full-access", name: "danger-full-access", description: "Full file access." },
  ],
  currentValue: "workspace-write",
};

interface FakeElectron {
  session: {
    permissions: (sessionId: string) => Promise<unknown>;
    onProjection: (cb: (p: unknown) => void) => () => void;
  };
  runtime: {
    executeCommand: (req: { sessionId: string; line: string }) => Promise<{ kind: string }>;
  };
}

let projectionCb: ((p: unknown) => void) | undefined;
let executeCommand: ReturnType<typeof installExecuteCommand>;
function installExecuteCommand() {
  return vi.fn(async (_req: { sessionId: string; line: string }) => ({ kind: "success" }));
}
let permissionsImpl: () => Promise<unknown>;

function installFake() {
  projectionCb = undefined;
  executeCommand = installExecuteCommand();
  permissionsImpl = async () => ({ ok: true, value: { ...SELECT } });
  const fake: FakeElectron = {
    session: {
      permissions: () => permissionsImpl(),
      onProjection: (cb) => { projectionCb = cb as (p: unknown) => void; return () => { projectionCb = undefined; }; },
    },
    runtime: { executeCommand },
  };
  (window as unknown as { electron?: unknown }).electron = fake;
}

beforeEach(() => { installFake(); });
afterEach(() => { delete (window as unknown as { electron?: unknown }).electron; });

/** The app root provides the Radix tooltip context — mirror it here. */
function renderSelect(sessionId = "sess-1") {
  return render(
    <TooltipProvider>
      <AgentPermissionSelect sessionId={sessionId} />
    </TooltipProvider>,
  );
}

describe("AgentPermissionSelect", () => {
  it("renders the snapshot's current preset", async () => {
    renderSelect();
    // Trigger shows the current option's label once the snapshot lands.
    expect(await screen.findByText("workspace-write")).toBeTruthy();
  });

  it("executes /permission <preset> through runtime.executeCommand on change", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(await screen.findByText("workspace-write"));
    await user.click(await screen.findByText("danger-full-access"));
    await waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1));
    expect(executeCommand).toHaveBeenCalledWith({ sessionId: "sess-1", line: "/permission danger-full-access" });
  });

  it("shows the derived custom row but never executes it", async () => {
    permissionsImpl = async () => ({
      ok: true,
      value: {
        options: [...SELECT.options, { value: "custom", name: "Custom", description: "No preset matches." }],
        currentValue: "custom",
      },
    });
    const user = userEvent.setup();
    renderSelect();
    await user.click(await screen.findByText("Custom"));
    expect(await screen.findByText("workspace-write")).toBeTruthy();
    await user.click(screen.getByText("workspace-write"));
    // Either the menu item is disabled (no call) or the click is ignored —
    // in no case does picking Custom execute a command.
    await user.click(screen.getByText("Custom")).catch(() => undefined);
    expect(executeCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ line: "/permission custom" }),
    );
  });

  it("updates from live permissions projections", async () => {
    renderSelect();
    expect(await screen.findByText("workspace-write")).toBeTruthy();
    act(() => {
      projectionCb?.({
        sessionId: "sess-1",
        kind: "permissions",
        data: { ...SELECT, currentValue: "danger-full-access" },
      });
    });
    expect(await screen.findByText("danger-full-access")).toBeTruthy();
  });

  it("ignores projections for other sessions", async () => {
    renderSelect();
    expect(await screen.findByText("workspace-write")).toBeTruthy();
    act(() => {
      projectionCb?.({
        sessionId: "sess-2",
        kind: "permissions",
        data: { ...SELECT, currentValue: "danger-full-access" },
      });
    });
    // Still the snapshot value — wait a beat to let any bad update land.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("danger-full-access")).toBeNull();
  });

  it("hides while the presets service is unavailable", async () => {
    permissionsImpl = async () => ({ ok: false, code: "unavailable", message: "no shell yet" });
    const { container } = renderSelect();
    // Let the rejected snapshot settle, then assert nothing rendered.
    await new Promise((r) => setTimeout(r, 50));
    expect(container.firstChild).toBeNull();
  });
});
