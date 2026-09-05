"use client";

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpForm } from "./McpForm";
import type { McpServerConfig } from "@/types";

/**
 * Renderer tests for the dev-only dsh-path spike toggle — no Electron, no DB.
 * Pins: hidden without the dev prop; visible with it; save payload carries
 * the flag; non-dev saves preserve the stored value.
 */

const base = {
  id: "m1",
  workspaceId: "ws1",
  name: "Test",
  transport: "http",
  baseUrl: "https://mcp.example.com/mcp",
  enabled: true,
  source: "manual",
} as McpServerConfig;

describe("McpForm dsh-path toggle", () => {
  it("hides the toggle without the dev prop", () => {
    render(<McpForm initial={base} onSave={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(/Route via dsh/)).toBeNull();
  });

  it("shows the toggle with dev and includes the flag in the save payload", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<McpForm initial={base} dev onSave={onSave} onCancel={() => {}} />);
    const box = screen.getByRole("checkbox", { name: /Route via dsh/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    await user.click(box);
    await user.click(screen.getByRole("button", { name: /Save server/ }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ dshPath: true });
  });

  it("preserves a stored flag when dev is off", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<McpForm initial={{ ...base, dshPath: true }} onSave={onSave} onCancel={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Save server/ }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ dshPath: true });
  });
});
