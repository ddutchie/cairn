import { Platform } from "react-native";
import { Host, Spacer } from "@expo/ui/swift-ui";
import { onHingeChange } from "@expo/ui/swift-ui/modifiers";
import { rememberHingeStatus } from "@/lib/hinge";

/**
 * Always-mounted, invisible hinge observer (iPhone Duo). `onHingeChange` needs a
 * SwiftUI view to hang off, and the others (the Projects split view, an open
 * preview pane) come and go — with Chat showing and no preview open, nothing else
 * reports, so `useFold()` would stay null and the laptop-pose layouts never apply.
 * Mounted once at the app root; feeds the shared cache in `src/lib/hinge.ts`.
 */
export function HingeObserver() {
  if (Platform.OS !== "ios") return null;
  return (
    <Host pointerEvents="none" style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}>
      <Spacer modifiers={[onHingeChange((_, next) => rememberHingeStatus(next.hinge?.status ?? null))]} />
    </Host>
  );
}
