import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resetOpenedCards, useOpenedCard } from "./opened-cards";

describe("useOpenedCard", () => {
  beforeEach(() => resetOpenedCards());

  it("remembers an opened card for a new mount of the same call", () => {
    const a = renderHook(() => useOpenedCard("c1"));
    expect(a.result.current[0]).toBe(false);
    act(() => a.result.current[1](true));
    a.unmount();
    expect(renderHook(() => useOpenedCard("c1")).result.current[0]).toBe(true);
  });

  it("forgets it once closed, and keeps calls apart", () => {
    const a = renderHook(() => useOpenedCard("c1"));
    act(() => a.result.current[1](true));
    act(() => a.result.current[1](false));
    expect(renderHook(() => useOpenedCard("c1")).result.current[0]).toBe(false);
    expect(renderHook(() => useOpenedCard("c2")).result.current[0]).toBe(false);
  });

  it("is plain local state without a key, and honours the initial value", () => {
    const a = renderHook(() => useOpenedCard(undefined, true));
    expect(a.result.current[0]).toBe(true);
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    a.unmount();
    expect(renderHook(() => useOpenedCard(undefined)).result.current[0]).toBe(false);
  });
});
