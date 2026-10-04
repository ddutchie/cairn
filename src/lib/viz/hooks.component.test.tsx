import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useResizeObserver } from "./hooks";

type Callback = () => void;
const observers: { cb: Callback; disconnected: boolean }[] = [];
class FakeResizeObserver {
  entry: { cb: Callback; disconnected: boolean };
  constructor(cb: Callback) { this.entry = { cb, disconnected: false }; observers.push(this.entry); }
  observe() {}
  disconnect() { this.entry.disconnected = true; }
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

function Harness({ onResize, dep }: { onResize: (el: HTMLDivElement) => void; dep: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useResizeObserver(ref, onResize, [dep]);
  return <div ref={ref} />;
}

describe("useResizeObserver", () => {
  it("measures on mount, on resize, with the latest callback, and re-observes on deps", () => {
    const first = vi.fn();
    const { rerender, unmount } = render(<Harness onResize={first} dep={1} />);
    expect(first).toHaveBeenCalledOnce();

    const second = vi.fn();
    rerender(<Harness onResize={second} dep={1} />);
    observers.at(-1)!.cb();
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();

    rerender(<Harness onResize={second} dep={2} />);
    expect(observers.at(-2)!.disconnected).toBe(true);
    expect(second).toHaveBeenCalledTimes(2);

    unmount();
    expect(observers.at(-1)!.disconnected).toBe(true);
  });
});
