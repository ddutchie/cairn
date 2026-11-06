/** How close to the end still counts as "at the bottom", in px. */
const BOTTOM_THRESHOLD = 32;
/** Closer than this is the end itself, allowing for fractional scroll positions, in px. */
const AT_END = 2;
/** How long after input a move still counts as the user's, in ms. Covers smooth scrolling. */
const INPUT_WINDOW_MS = 400;

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
 * Input alone can't tell either: a wheel over a nested panel scrolls that panel.
 */
export function createBottomFollower(el: HTMLElement): BottomFollower {
  let following = true;
  let draggingScrollbar = false;
  let lastTop = el.scrollTop;
  let upwardInputAt = Number.NEGATIVE_INFINITY;
  let downwardInputAt = Number.NEGATIVE_INFINITY;

  const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
  const toEnd = () => { el.scrollTop = el.scrollHeight; lastTop = el.scrollTop; };

  /** Reads where the scroller has moved to since last time. A move up right after a touch is the user's. */
  const readMovement = () => {
    const movedUp = el.scrollTop < lastTop;
    lastTop = el.scrollTop;
    if (movedUp && performance.now() - upwardInputAt < INPUT_WINDOW_MS) following = false;
    return movedUp;
  };

  /** Whether a panel between the wheel's target and the transcript takes an upward scroll. */
  const nestedPanelTakesWheel = (target: EventTarget | null) => {
    for (let node = target instanceof Element ? target : null; node && node !== el; node = node.parentElement) {
      if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return true;
    }
    return false;
  };

  // Decided from the event, not from scrollTop: while a reply streams the virtualizer's
  // own shifts can outweigh a small scroll up and hide it.
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY > 0) downwardInputAt = performance.now();
    else if (e.deltaY < 0 && el.scrollTop > 0 && !nestedPanelTakesWheel(e.target)) following = false;
  };
  const onTouchMove = () => { upwardInputAt = performance.now(); downwardInputAt = upwardInputAt; };
  const onKeyDown = (e: KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) { if (el.scrollTop > 0) following = false; }
    else if (["ArrowDown", "PageDown", "End", " "].includes(e.key)) downwardInputAt = performance.now();
  };
  const onPointerDown = () => { draggingScrollbar = true; };
  const onPointerUp = () => { draggingScrollbar = false; };
  const onScroll = () => {
    const movedUp = readMovement();
    if (gap() > BOTTOM_THRESHOLD) { if (draggingScrollbar) following = false; return; }
    // Near the end, resume only if the user came back down. A shift from the virtualizer
    // must not resume, or a slow scroll up is pulled back to the end by every new line.
    const cameBack = draggingScrollbar || performance.now() - downwardInputAt < INPUT_WINDOW_MS;
    if (!movedUp && (gap() <= AT_END || cameBack)) following = true;
  };

  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("scroll", onScroll, { passive: true });

  return {
    contentChanged: () => {
      // The user's scroll may not have reported yet: don't undo it.
      readMovement();
      if (following) toEnd();
    },
    follow: () => { following = true; toEnd(); },
    detach: () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("scroll", onScroll);
    },
  };
}
