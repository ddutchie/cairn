import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useIpcQuery } from "./useIpcQuery";
import { IpcUnavailableError } from "@/lib/ipc/client";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("useIpcQuery", () => {
  it("loads, then exposes data and clears loading", async () => {
    const { result } = renderHook(() => useIpcQuery(() => Promise.resolve(42), []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeNull();
  });

  it("keeps initial data and reports the error message on failure", async () => {
    const { result } = renderHook(() =>
      useIpcQuery(() => Promise.reject(new Error("boom")), [], { initialData: [] as number[] }),
    );
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(false);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("stays quiet outside Electron", async () => {
    const { result } = renderHook(() =>
      useIpcQuery(() => Promise.reject(new IpcUnavailableError()), [], { initialData: "idle" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe("idle");
  });

  it("drops a response that lands after deps changed", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const loaders: Record<string, Promise<string>> = { a: slow.promise, b: fast.promise };
    const { result, rerender } = renderHook(({ key }) => useIpcQuery(() => loaders[key], [key]), {
      initialProps: { key: "a" },
    });
    rerender({ key: "b" });
    await act(async () => { fast.resolve("b-data"); });
    await act(async () => { slow.resolve("a-data"); });
    expect(result.current.data).toBe("b-data");
    expect(result.current.loading).toBe(false);
  });

  it("resets to initial data and clears the error when deps change", async () => {
    const pending = deferred<string>();
    const { result, rerender } = renderHook(
      ({ key }) => useIpcQuery(() => (key === "a" ? Promise.reject(new Error("a failed")) : pending.promise), [key], { initialData: "none" }),
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(result.current.error).toBe("a failed"));
    rerender({ key: "b" });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe("none");
    await act(async () => { pending.resolve("b-data"); });
    expect(result.current.data).toBe("b-data");
  });

  it("drops an older response that lands after a newer one", async () => {
    const calls = [deferred<string>(), deferred<string>(), deferred<string>()];
    let n = 0;
    const { result } = renderHook(() => useIpcQuery(() => calls[n++].promise, []));
    await act(async () => { calls[0].resolve("first"); });
    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => { older = result.current.reload({ silent: true }); newer = result.current.reload(); });
    await act(async () => { calls[2].resolve("newest"); await newer; });
    await act(async () => { calls[1].resolve("stale"); await older; });
    expect(result.current.data).toBe("newest");
    expect(result.current.loading).toBe(false);
  });

  it("keeps the previous object when isEqual says nothing changed", async () => {
    let n = 0;
    const loader = () => Promise.resolve({ v: 1, call: ++n });
    const { result } = renderHook(() => useIpcQuery(loader, [], { isEqual: (a, b) => a.v === b.v }));
    await waitFor(() => expect(result.current.data).toBeDefined());
    const first = result.current.data;
    await act(() => result.current.reload());
    expect(n).toBe(2);
    expect(result.current.data).toBe(first);
  });

  it("polls silently without toggling loading", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(() => Promise.resolve("x"));
    const { result } = renderHook(() => useIpcQuery(loader, [], { pollMs: 1000 }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.loading).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
  });

  it("does nothing while disabled", () => {
    const loader = vi.fn(() => Promise.resolve(1));
    const { result } = renderHook(() => useIpcQuery(loader, [], { enabled: false }));
    expect(loader).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
