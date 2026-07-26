import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import ConfettiCannon from "react-native-confetti-cannon";
import { useTheme } from "@/theme";

/**
 * A one-shot confetti burst overlay for celebration moments (task complete,
 * project 100%, streak milestones). Rendered once at the app root inside
 * <ToastProvider>; fired imperatively via the module-level {@link confetti}
 * trigger so any call site (board drop handler, save flow) can celebrate
 * without prop-drilling.
 *
 * Uses react-native-confetti-cannon (pure-JS, no native build → Expo-Go safe).
 * Each fire remounts the cannon (keyed on a bump counter) so bursts can repeat
 * back-to-back and always start from frame zero.
 */

let externalFire: (() => void) | null = null;

/** Fire a confetti burst from anywhere. No-op until <ConfettiHost> is mounted. */
export function confetti(): void {
  externalFire?.();
}

export function ConfettiHost() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  // `burst` doubles as a mount key and a "has ever fired" gate (0 = idle).
  const [burst, setBurst] = useState(0);

  useEffect(() => {
    externalFire = () => setBurst((n) => n + 1);
    return () => {
      if (externalFire) externalFire = null;
    };
  }, []);

  if (burst === 0) return null;

  // Brand-forward palette: accent + the semantic reward colours.
  const colors = [t.accent, t.success, t.info, t.warning, t.accentHover];

  return (
    <ConfettiCannon
      key={burst}
      count={90}
      // Launch from just above centre so pieces arc up and rain down over the
      // board / card view.
      origin={{ x: width / 2, y: -20 }}
      explosionSpeed={340}
      fallSpeed={2600}
      fadeOut
      autoStart
      colors={colors}
    />
  );
}
