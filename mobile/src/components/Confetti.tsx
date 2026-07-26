import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import ConfettiCannon from "react-native-confetti-cannon";
import { useTheme, type Theme } from "@/theme";

/**
 * A one-shot confetti burst overlay for celebration moments (task complete,
 * project 100%, streak milestones, game wins). Rendered once at the app root
 * inside <ToastProvider>; fired imperatively via the module-level {@link confetti}
 * trigger so any call site (board drop handler, save flow) can celebrate
 * without prop-drilling.
 *
 * NOTE: React Native's <Modal> presents in a separate view hierarchy, so the
 * app-root host sits BEHIND any fullscreen modal (e.g. the hidden games) and
 * can't be seen there. For in-modal celebrations, render {@link InlineConfetti}
 * directly inside the modal instead, keyed on a bump counter.
 *
 * Uses react-native-confetti-cannon (pure-JS, no native build → Expo-Go safe).
 * Each fire remounts the cannon (keyed on a bump counter) so bursts can repeat
 * back-to-back and always start from frame zero.
 */

/** Brand-forward confetti palette: accent + the semantic reward colours. */
function confettiColors(t: Theme): string[] {
  return [t.accent, t.success, t.info, t.warning, t.accentHover];
}

/**
 * A configured confetti cannon for use anywhere — pass a `fireKey` that changes
 * each time you want a burst (0 = idle, no render). Centralises the count /
 * speed / palette so every celebration looks the same.
 */
export function InlineConfetti({ fireKey }: { fireKey: number }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  // Track the last fireKey whose burst has finished, so we unmount the cannon
  // once it's done. Without this the ~90 animated confetti views stay mounted
  // after the burst and re-render on every parent frame (the games re-render
  // ~60fps), dragging the frame rate to a crawl.
  const [doneKey, setDoneKey] = useState(0);

  if (fireKey <= 0 || fireKey === doneKey) return null;
  return (
    <ConfettiCannon
      key={fireKey}
      count={90}
      // Launch from just above centre so pieces arc up and rain down.
      origin={{ x: width / 2, y: -20 }}
      explosionSpeed={340}
      fallSpeed={2600}
      fadeOut
      autoStart
      colors={confettiColors(t)}
      onAnimationEnd={() => setDoneKey(fireKey)}
    />
  );
}

let externalFire: (() => void) | null = null;

/** Fire a confetti burst from anywhere. No-op until <ConfettiHost> is mounted. */
export function confetti(): void {
  externalFire?.();
}

export function ConfettiHost() {
  // `burst` doubles as a mount key and a "has ever fired" gate (0 = idle).
  const [burst, setBurst] = useState(0);

  useEffect(() => {
    externalFire = () => setBurst((n) => n + 1);
    return () => {
      if (externalFire) externalFire = null;
    };
  }, []);

  return <InlineConfetti fireKey={burst} />;
}
