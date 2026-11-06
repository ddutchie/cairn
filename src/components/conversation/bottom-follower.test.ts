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

  it("stops following on a small scroll up that stays near the end", () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -4 }));
    el.scrollTop = 490;
    el.dispatchEvent(new Event("scroll"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(490);
  });

  it("stays stopped when the virtualizer shifts the scroller after a small scroll up", () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -4 }));
    el.scrollTop = 490;
    el.dispatchEvent(new Event("scroll"));
    el.scrollTop = 495; // moved down, near the end, but no user input went down
    el.dispatchEvent(new Event("scroll"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(495);
  });

  it("resumes on a wheel down that lands near the end", () => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    el.scrollTop = 480;
    el.dispatchEvent(new Event("scroll"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("keeps following when a wheel up scrolls a nested panel instead", () => {
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 400 });
    panel.scrollTop = 50;
    el.appendChild(panel);
    panel.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("stops following when a nested panel at its top passes the wheel on", () => {
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 400 });
    el.appendChild(panel);
    panel.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    el.scrollTop = 400;
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(400);
  });

  it("keeps following after a wheel up when there is nothing to scroll yet", () => {
    el.scrollTop = 0;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("keeps following when the virtualizer moves the scroller up without user input", () => {
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
  });

  it("stops following on Shift+Space", () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true }));
    el.scrollTop = 100;
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(100);
  });

  it("a cancelled pointer doesn't count as dragging the scrollbar", () => {
    el.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("pointercancel"));
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    grow(el, 1800);
    follower.contentChanged();
    expect(el.scrollTop).toBe(1800);
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
