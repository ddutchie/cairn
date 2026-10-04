import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useResizableDivider, type ResizableDividerOptions } from "./useResizableDivider";

function Harness({ opts }: { opts: Omit<ResizableDividerOptions, "axis"> & { axis?: "x" | "y" } }) {
  const ref = useRef<HTMLDivElement>(null);
  useResizableDivider(ref, { axis: "x", ...opts });
  return <div ref={ref} data-testid="divider" />;
}

describe("useResizableDivider", () => {
  it("reports travel since mousedown and locks the body cursor while dragging", () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    render(<Harness opts={{ startSize: () => 300, onMove, onEnd }} />);

    fireEvent.mouseDown(screen.getByTestId("divider"), { clientX: 100 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.mouseMove(window, { clientX: 140 });
    expect(onMove).toHaveBeenLastCalledWith(40, 300);

    fireEvent.mouseUp(window);
    expect(onEnd).toHaveBeenCalledWith(false);
    expect(document.body.style.cursor).toBe("");

    fireEvent.mouseMove(window, { clientX: 200 });
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("uses the vertical axis and a row-resize cursor", () => {
    const onMove = vi.fn();
    render(<Harness opts={{ axis: "y", startSize: () => 200, onMove }} />);
    fireEvent.mouseDown(screen.getByTestId("divider"), { clientY: 500 });
    expect(document.body.style.cursor).toBe("row-resize");
    fireEvent.mouseMove(window, { clientY: 450 });
    expect(onMove).toHaveBeenLastCalledWith(-50, 200);
    fireEvent.mouseUp(window);
  });

  it("ends an in-flight drag as interrupted when it unmounts", () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const { unmount } = render(<Harness opts={{ startSize: () => 0, onMove: () => {}, onStart, onEnd }} />);
    fireEvent.mouseDown(screen.getByTestId("divider"), { clientX: 0 });
    expect(onStart).toHaveBeenCalledOnce();
    unmount();
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(document.body.style.userSelect).toBe("");
  });
});
