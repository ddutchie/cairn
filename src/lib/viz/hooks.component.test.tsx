import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useResizeObserver } from "./hooks";

type Callback = () => void;
interface Fake { cb: Callback; el: Element | null; disconnected: boolean }
const observers: Fake[] = [];
class FakeResizeObserver {
  entry: Fake;
  constructor(cb: Callback) { this.entry = { cb, el: null, disconnected: false }; observers.push(this.entry); }
  observe(el: Element) { this.entry.el = el; }
  disconnect() { this.entry.disconnected = true; }
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

function Harness({ onResize, dep = 0, empty = false }: { onResize: (el: HTMLElement) => void; dep?: number; empty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useResizeObserver(ref, onResize, [dep]);
  // Mirrors canvases that return a different element for their empty state.
  if (empty) return <section ref={ref as never} data-empty />;
  return <div ref={ref} />;
}

describe("useResizeObserver", () => {
  it("measures on mount and on resize with the latest callback", () => {
    observers.length = 0;
    const first = vi.fn();
    const { rerender, unmount } = render(<Harness onResize={first} />);
    expect(first).toHaveBeenCalledOnce();

    const second = vi.fn();
    rerender(<Harness onResize={second} />);
    observers.at(-1)!.cb();
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();

    unmount();
    expect(observers.at(-1)!.disconnected).toBe(true);
  });

  it("re-measures when deps change", () => {
    const spy = vi.fn();
    const { rerender } = render(<Harness onResize={spy} dep={1} />);
    rerender(<Harness onResize={spy} dep={2} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("re-observes when the ref moves to a new element", () => {
    observers.length = 0;
    const spy = vi.fn();
    const { rerender } = render(<Harness onResize={spy} empty />);
    expect(observers[0].el?.tagName).toBe("SECTION");
    rerender(<Harness onResize={spy} />);
    expect(observers[0].disconnected).toBe(true);
    expect(observers.at(-1)!.el?.tagName).toBe("DIV");
    expect(spy.mock.calls.at(-1)![0].tagName).toBe("DIV");
  });
});
