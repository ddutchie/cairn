import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { Platform, AppState, type AppStateStatus } from "react-native";
import { useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tabBarClosedLift, KEYBOARD_OPEN_GAP } from "@/theme";

/** Composer height assumed before its first onLayout measurement. */
export const COMPOSER_FALLBACK_H = 60;

type ScrollRef = React.RefObject<ComponentRef<typeof KeyboardChatScrollView> | null>;

export interface ChatScroll {
  /** Attach to the KeyboardChatScrollView. */
  scrollRef: ScrollRef;
  /** Remount key that invalidates the stale iOS glass backdrop on resume. */
  resumeKey: number;
  /** Whether the user is at/near the bottom of the transcript (mutable ref). */
  nearBottom: React.RefObject<boolean>;
  /** Native keyboard-lift offset for KeyboardChatScrollView. */
  offset: number;
  /** Bottom padding the transcript keeps clear below the last message. */
  extraContentPadding: SharedValue<number>;
  /** How far the composer rests above the tab bar when the keyboard is closed. */
  closedLift: number;
  /** Report the measured composer height (onLayout). */
  setComposerH: (h: number) => void;
  /** Mark intent to follow the newest message (e.g. on send / input focus). */
  followEnd: () => void;
  /** Scroll to the end after paint (rAF + short fallback). */
  scrollToEndSoon: (animated?: boolean) => void;
}

/**
 * Owns the chat transcript's keyboard/scroll choreography — the genuinely
 * device-tuned part of the screen — so the screen component reads as pure
 * composition. Nothing here changes behaviour vs the previous inline logic; it
 * is a verbatim relocation.
 *
 * @param msgCount current number of messages (drives the follow-on-growth effect)
 */
export function useChatScroll(msgCount: number): ChatScroll {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ComponentRef<typeof KeyboardChatScrollView> | null>(null);

  // Resume-repaint key. iOS composites its cached UIKit snapshot over the live
  // hierarchy when the app returns from background; the composer's native Liquid
  // Glass layer (GlassBar → GlassView) samples a backdrop that stays stale until
  // the next paint, leaving translucent vertical "ghost bands" over the
  // transformed scroll content (tool chips + avatar column) until the user
  // interacts. Bumping this key on the "active" transition remounts that content
  // so the stale backdrop is invalidated immediately. iOS-only — the artifact is
  // specific to the native glass layer, and remounting on Android would only
  // throw away scroll state for no benefit.
  const [resumeKey, setResumeKey] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") setResumeKey((k) => k + 1);
    });
    return () => sub.remove();
  }, []);

  // Whether the user is at/near the bottom of the transcript. Auto-follow on
  // content growth only when true, so expanding a past message's reasoning block
  // (or other layout changes while scrolled up) doesn't yank the view to the end.
  const nearBottom = useRef(true);

  const scrollToEndSoon = useCallback((animated = false) => {
    scrollRef.current?.scrollToEnd({ animated });
  }, []);
  const followEnd = useCallback(() => {
    nearBottom.current = true;
  }, []);

  // Jump to the latest message on first mount, on resume-remount, and whenever a
  // NEW message is added while at/near the bottom. Without this the transcript
  // opened scrolled to the TOP with restored history — `onContentSizeChange`
  // only fires `scrollToEnd` when `nearBottom` is already true, and a first-paint
  // `onEndVisible(false)` (overflowing restored history) could flip it false and
  // strand the view until a manual send. We scroll after paint (rAF + a short
  // fallback) so the ScrollView has measured its content + insets. Mount/resume
  // force the jump (they reset intent to "follow"); count growth respects
  // `nearBottom` so we don't yank a user who scrolled up to read.
  const prevMsgCount = useRef(msgCount);
  useEffect(() => {
    const isMountOrResume = prevMsgCount.current === msgCount; // effect ran w/o a count change → mount/resumeKey
    const grew = msgCount > prevMsgCount.current;
    prevMsgCount.current = msgCount;
    if (msgCount === 0) return;
    if (isMountOrResume) nearBottom.current = true; // opening the transcript = follow the end
    if (!isMountOrResume && grew && !nearBottom.current) return; // user scrolled up; don't yank
    const raf = requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [msgCount, resumeKey]);

  // Lift the composer just above the tab bar when the keyboard is closed
  // (shared with the search scope bar so both rest at the same height).
  const closedLift = tabBarClosedLift(insets.bottom);

  // Height the composer occupies, measured lazily (falls back before layout).
  const [composerH, setComposerH] = useState(COMPOSER_FALLBACK_H);
  // Bottom padding the transcript keeps clear below the last message so it's not
  // hidden by the floating composer. This is the CLOSED-keyboard clearance:
  // composer height + margin + where the composer rests above the tab bar
  // (closedLift). When the keyboard opens, KeyboardChatScrollView adds
  // (keyboardHeight - offset); with offset = closedLift - KEYBOARD_OPEN_GAP that
  // resolves to composerH + 12 + keyboardHeight + KEYBOARD_OPEN_GAP — i.e. the
  // content clears the composer (which itself rides KEYBOARD_OPEN_GAP above the
  // keyboard) without double-counting closedLift. Shared value because the
  // component consumes it on the UI thread.
  const extraContentPadding = useSharedValue(COMPOSER_FALLBACK_H + 12 + closedLift);
  useEffect(() => {
    // Animate (not snap) so the transcript padding eases when the composer grows
    // to multiple lines or the tab-bar lift changes, matching the keyboard's own
    // motion instead of jumping.
    extraContentPadding.value = withTiming(composerH + 12 + closedLift);
  }, [composerH, closedLift, extraContentPadding]);

  return {
    scrollRef,
    resumeKey,
    nearBottom,
    offset: Math.max(closedLift - KEYBOARD_OPEN_GAP, 0),
    extraContentPadding,
    closedLift,
    setComposerH,
    followEnd,
    scrollToEndSoon,
  };
}
