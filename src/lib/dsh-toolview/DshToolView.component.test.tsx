import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DshToolView, hasToolView, registeredToolViewKeys, registerBuiltinToolViews } from "./index";
import { toToolCallViewProps } from "./adapter";
import type { ChatToolCall } from "@/hooks/useChatStream";

/**
 * §11 spike proof: a real dsh `tool.call.toolview` component (the vendored
 * SkillRow) renders inside Cairn from a Cairn-built ToolCallViewProps — WITHOUT
 * the dsh web shell. Deterministic (no live model): we hand it ChatToolCalls.
 */

const skillDone = (output: string, ok = true): ChatToolCall => ({
  tool: "skill",
  label: "skill",
  status: "done",
  ok,
  callId: "call-1",
  args: JSON.stringify({ name: "secret-greeter" }),
  output,
  ...(ok ? {} : { error: "boom" }),
});

describe("DshToolView (§11 toolview micro-host)", () => {
  it("registers the built-in skill toolview keyed by tool name", () => {
    registerBuiltinToolViews();
    expect(hasToolView("skill")).toBe(true);
    expect(registeredToolViewKeys()).toContain("skill");
    // Unregistered tools fall through to Cairn's own chip.
    expect(hasToolView("get_active_context")).toBe(false);
  });

  it("renders the dsh SkillRow for a settled skill call, scoped for theming", () => {
    const { container } = render(<DshToolView tc={skillDone("Reply with BANANA-PROTOCOL-7")} />);
    // The dsh component rendered its accent row…
    expect(screen.getByText("Skill")).toBeTruthy();
    // …with the skill name from the call args…
    expect(screen.getByText("secret-greeter")).toBeTruthy();
    // …inside the theme-shim scope (so --dsw-* tokens resolve to Cairn's --*).
    expect(container.querySelector(".dsh-toolview-scope")).toBeTruthy();
    expect(container.querySelector('[data-tool="skill"][data-state="ok"]')).toBeTruthy();
  });

  it("expands to show the loaded instructions (the durable tool output)", async () => {
    const user = userEvent.setup();
    render(<DshToolView tc={skillDone("Reply with BANANA-PROTOCOL-7")} />);
    // Output is present but collapsed until the row is toggled.
    const row = screen.getByRole("button");
    await user.click(row);
    expect(screen.getByText("Reply with BANANA-PROTOCOL-7")).toBeTruthy();
    expect(screen.getByText("Instructions")).toBeTruthy();
  });

  it("reflects error state from the block", () => {
    const { container } = render(<DshToolView tc={skillDone("failed to load skill", false)} />);
    expect(container.querySelector('[data-tool="skill"][data-state="error"]')).toBeTruthy();
  });

  it("renders a running skill call (streaming block, no output yet)", () => {
    const running: ChatToolCall = { tool: "skill", label: "skill", status: "running", callId: "c", args: JSON.stringify({ name: "loading-skill" }) };
    const { container } = render(<DshToolView tc={running} />);
    expect(container.querySelector('[data-tool="skill"][data-state="running"]')).toBeTruthy();
    expect(screen.getByText("loading-skill")).toBeTruthy();
  });

  it("returns null for a tool with no registered view (caller uses Cairn's chip)", () => {
    const other: ChatToolCall = { tool: "get_note", label: "get_note", status: "done", ok: true, callId: "c", args: "{}", output: "note" };
    const { container } = render(<DshToolView tc={other} />);
    expect(container.firstChild).toBeNull();
  });

  // Regression: the durable/pop-out transcript maps ConversationToolCall.running
  // -> status. When that mapping was missing (status undefined), the adapter
  // always took the settled path, so a running keyed toolview rendered as done.
  it("adapter emits a running block when status is running (not settled)", () => {
    const props = toToolCallViewProps({
      tool: "skill",
      label: "skill",
      status: "running",
      callId: "c",
      args: JSON.stringify({ name: "loading-skill" }),
    } as ChatToolCall);
    // A RunningToolCall has no kind:"tool-result" discriminator.
    expect("kind" in props.block).toBe(false);
    const { container } = render(<DshToolView tc={{ tool: "skill", label: "skill", status: "running", callId: "c", args: JSON.stringify({ name: "loading-skill" }) } as ChatToolCall} />);
    expect(container.querySelector('[data-tool="skill"][data-state="running"]')).toBeTruthy();
  });
});
