// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBottomFollower, type BottomFollower } from "./bottom-follower";

function scroller(scrollHeight: number, clientHeight = 500) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight, writable: true });
  return el;
}
const grow = (el: HTMLElement, height: number) => Object.defineProperty(el, "scrollHeight", { configurable: true, value: height });

describe("createBottomFollower", () => {
  let el: HTMLElement;
  let follower: BottomFollower;
  beforeEach(() => { el = scroller(1000); el.scrollTop = 500; follower = createBottomFollower(el); });
  afterEach(() => follower.detach());

  it("follows content as it grows", () => {
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("keeps following when growth leaves the end behind before the scroll event", () => {
    grow(el, 1800);
    el.dispatchEvent(new Event("scroll"));
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("stops following when the user scrolls up", () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    el.scrollTop = 200;
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(200);
  });

  it("resumes when the user returns to the bottom", () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    el.scrollTop = 500;
    el.dispatchEvent(new Event("scroll"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("stops following when the user drags the scrollbar away", () => {
    el.dispatchEvent(new Event("pointerdown"));
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("pointerup"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(100);
  });

  it("goes to the end on request even after scrolling up", () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    el.scrollTop = 200;
    grow(el, 1800);
    follower.follow();
    expect(el.scrollTop).toBe(1800);
  });
});
