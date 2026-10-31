import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const started = vi.hoisted(() => ({ scanning: 0 }));
vi.mock("loadersz/scanning", () => ({
  LoaderszLoader: class {
    constructor() { started.scanning += 1; }
    destroy() {}
    setOptions() {}
  },
}));
vi.mock("loadersz/typing", () => ({ LoaderszLoader: class { destroy() {} } }));
vi.mock("loadersz/rendering", () => ({ LoaderszLoader: class { constructor() { throw new Error("no canvas"); } destroy() {} } }));

import { WorkLoader } from "./work-loader";

describe("WorkLoader", () => {
  it("draws a hidden canvas tagged with its phase, sized as asked", () => {
    const { container } = render(<WorkLoader phase="thinking" size={20} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toHaveAttribute("data-work-phase", "thinking");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas).toHaveStyle({ width: "20px", height: "20px" });
  });

  it("starts the loader for its phase and swaps it when the phase changes", async () => {
    const { rerender } = render(<WorkLoader phase="thinking" />);
    await waitFor(() => expect(started.scanning).toBe(1));
    rerender(<WorkLoader phase="responding" />);
    await waitFor(() => expect(document.querySelector("canvas")).toHaveAttribute("data-work-phase", "responding"));
  });

  it("falls back to the spinner when the loader can't start", async () => {
    const { container } = render(<WorkLoader phase="sending" />);
    await waitFor(() => expect(container.querySelector("canvas")).toBeNull());
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
