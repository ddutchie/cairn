/** How close to the end still counts as "at the bottom", in px. */
const BOTTOM_THRESHOLD = 32;

export interface BottomFollower {
  /** Scroll to the end if the transcript is following. Call when its content grows. */
  contentChanged: () => void;
  /** Start following again and go to the end, e.g. when the user sends a message. */
  follow: () => void;
  detach: () => void;
}

/**
 * Keeps a scroller at its end while content grows, until the user scrolls away.
 *
 * Only the user's own input stops following. A scroll position alone can't tell:
 * growing content also moves the end away from the viewport, and the virtualizer
 * shifts scrollTop as it measures rows, so neither may count as scrolling up.
 */
export function createBottomFollower(el: HTMLElement): BottomFollower {
  let following = true;
  let draggingScrollbar = false;

  const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
  const toEnd = () => { el.scrollTop = el.scrollHeight; };
  const leave = () => { if (gap() > BOTTOM_THRESHOLD) following = false; };

  const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) following = false; };
  const onTouchMove = () => leave();
  const onKeyDown = (e: KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home"].includes(e.key)) following = false;
  };
  const onPointerDown = () => { draggingScrollbar = true; };
  const onPointerUp = () => { draggingScrollbar = false; };
  const onScroll = () => {
    if (gap() <= BOTTOM_THRESHOLD) following = true;
    else if (draggingScrollbar) following = false;
  };

  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  el.addEventListener("scroll", onScroll, { passive: true });

  return {
    contentChanged: () => { if (following) toEnd(); },
    follow: () => { following = true; toEnd(); },
    detach: () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("scroll", onScroll);
    },
  };
}
