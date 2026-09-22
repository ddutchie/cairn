import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * Regression test pinning the round-2 a11y fix: the fullscreen diagram modal
 * must render a dialog WITH an accessible name (the sr-only title), so
 * getByRole("dialog", { name }) resolves instead of matching an unnamed dialog.
 *
 * jsdom can't run real mermaid, so the module is mocked at the dynamic-import
 * boundary (getMermaid awaits import("mermaid")); the mock returns a trivial
 * SVG, which is all the modal needs to mount its ModalShell chrome.
 */

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` })),
  },
}));

async function openModal() {
  const user = userEvent.setup();
  render(<MermaidDiagram chart="graph TD; A-->B" />);
  // Inline render is async (dynamic import); the expand button mounts with it.
  const expand = await screen.findByRole("button", { name: "View full screen" });
  await user.click(expand);
  return user;
}

describe("MermaidDiagram modal accessible name", () => {
  it("renders a dialog WITH an accessible name", async () => {
    await openModal();
    const dialog = await screen.findByRole("dialog", {
      name: "Fullscreen Mermaid Diagram",
    });
    expect(dialog).toBeInTheDocument();
  });

  it("wires the accessible description for assistive tech", async () => {
    await openModal();
    const dialog = await screen.findByRole("dialog", {
      name: "Fullscreen Mermaid Diagram",
    });
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = describedBy
      ? document.getElementById(describedBy)
      : null;
    expect(description?.textContent).toMatch(/Fullscreen Mermaid Diagram/);
  });
});
