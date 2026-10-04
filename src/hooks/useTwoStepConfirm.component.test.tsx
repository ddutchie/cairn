import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTwoStepConfirm } from "./useTwoStepConfirm";

afterEach(() => vi.useRealTimers());

describe("useTwoStepConfirm", () => {
  it("arms on the first fire and runs on the second for the same key", () => {
    const action = vi.fn();
    const { result } = renderHook(() => useTwoStepConfirm(action));
    act(() => result.current.fire("a", 1));
    expect(result.current.armedKey).toBe("a");
    expect(action).not.toHaveBeenCalled();
    act(() => result.current.fire("a", 2));
    expect(action).toHaveBeenCalledWith(2);
    expect(result.current.armedKey).toBeNull();
  });

  it("re-arms for a different key and disarms after the timeout", () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const { result } = renderHook(() => useTwoStepConfirm(action, 1000));
    act(() => result.current.fire("a", 1));
    act(() => result.current.fire("b", 1));
    expect(result.current.armedKey).toBe("b");
    expect(action).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.armedKey).toBeNull();
  });
});
