import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MDPreviewPanel } from "./MDPreviewPanel";

/**
 * The preview panel has an S/M/L size toggle that shrinks/grows the panel and
 * (for S) densifies the text via --preview-scale. (Persistence to storage
 * mirrors the editor-mode pattern; not asserted here because the component-test
 * jsdom's localStorage is a no-op.)
 */
describe("MDPreviewPanel — size toggle", () => {
  afterEach(cleanup);

  it("defaults to medium and exposes S/M/L controls", () => {
    render(<MDPreviewPanel text="hello" onDismiss={() => {}} />);
    expect(screen.getByLabelText("S preview")).toBeInTheDocument();
    expect(screen.getByLabelText("M preview")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("L preview")).toBeInTheDocument();
  });

  it("switching to S selects it and shrinks the type scale; L is full size", () => {
    const { container } = render(<MDPreviewPanel text="hello" onDismiss={() => {}} />);
    const panel = () => container.querySelector("[data-md-preview-portal]") as HTMLElement;

    fireEvent.click(screen.getByLabelText("S preview"));
    expect(screen.getByLabelText("S preview")).toHaveAttribute("aria-pressed", "true");
    // S sets a sub-1 scale so text is denser.
    expect(parseFloat(panel().style.getPropertyValue("--preview-scale"))).toBeLessThan(1);

    fireEvent.click(screen.getByLabelText("L preview"));
    expect(screen.getByLabelText("L preview")).toHaveAttribute("aria-pressed", "true");
    // L keeps full-size type (only the panel grows taller).
    expect(parseFloat(panel().style.getPropertyValue("--preview-scale"))).toBe(1);
  });
});
