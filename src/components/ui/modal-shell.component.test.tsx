import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModalShell } from "./modal-shell";

/**
 * Regression tests for ModalShell's footer chrome (round-1 HIGH fix):
 * the footer row must render with padding/border/alignment classes in both
 * scrollable and non-scrollable modes.
 */

function footerEl(): HTMLElement | null {
  // The footer is the only row carrying the right-aligned action classes.
  return document.body.querySelector('div[class*="justify-end"]');
}

describe("ModalShell footer", () => {
  it("non-scrollable footer renders with padding/border/alignment classes", () => {
    render(
      <ModalShell onClose={vi.fn()} title="Confirm" footer={<button>Save</button>}>
        Body content
      </ModalShell>
    );
    expect(screen.getByText("Save")).toBeInTheDocument();
    const footer = footerEl();
    expect(footer).not.toBeNull();
    for (const cls of ["px-5", "py-4", "border-t", "flex", "justify-end", "gap-2"]) {
      expect(footer!.className).toContain(cls);
    }
    expect(footer!.className).toContain("border-[var(--border-subtle)]");
  });

  it("scrollable footer renders with the same chrome", () => {
    render(
      <ModalShell onClose={vi.fn()} title="Confirm" scrollable footer={<button>Apply</button>}>
        Body content
      </ModalShell>
    );
    expect(screen.getByText("Apply")).toBeInTheDocument();
    const footer = footerEl();
    expect(footer).not.toBeNull();
    for (const cls of ["px-5", "py-4", "border-t", "flex", "justify-end", "gap-2"]) {
      expect(footer!.className).toContain(cls);
    }
    expect(footer!.className).toContain("border-[var(--border-subtle)]");
  });

  it("renders no footer row when no footer is given", () => {
    render(
      <ModalShell onClose={vi.fn()} title="Plain">
        Body content
      </ModalShell>
    );
    expect(screen.getByText("Body content")).toBeInTheDocument();
    expect(footerEl()).toBeNull();
  });
});
