import { createModifier } from "@expo/ui/swift-ui/modifiers";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

interface DuoBarsNative {
  preferTabBarCompression(): Promise<Record<string, unknown> | number | boolean>;
}

const native =
  Platform.OS === "ios" ? requireOptionalNativeModule<DuoBarsNative>("DuoBars") : null;

/** Whether the DuoBars native module is linked into this build. */
export function duoBarsAvailable(): boolean {
  return native != null;
}

/**
 * Asks the system rail to preserve the tab bar and collapse toolbar items
 * into ··· first (Apple's default compression) on the tab screens. The Duo
 * rail merges the UIKit tab bar with SwiftUI column toolbars hosted inside
 * it — a mix the SwiftUI-only view modifiers can't govern — so this stamps
 * the owning view controllers' `navigationItem.verticalBarCompressionBehavior`
 * instead. Resolves the native diagnostic dict (TEMP-DIAG shape).
 * No-op off iOS / below 27.1.
 */
export async function preferTabBarCompression(): Promise<Record<string, unknown> | false> {
  if (!native) return false;
  try {
    const result = await native.preferTabBarCompression();
    return result != null && typeof result === "object" ? (result as Record<string, unknown>) : false;
  } catch {
    return false;
  }
}

/**
 * iPhone Duo vertical-bar control for @expo/ui `Toolbar`s (iOS 27.1+).
 * Neither expo-router nor @expo/ui exposes these — verified against
 * `@expo/ui@58.0.20` / `expo-router@58.0.23` — so this local module fills
 * the gap, following the `swiftui-modifiers` precedent.
 *
 * No-op below iOS 27.1 (the Swift side renders the content unchanged).
 */

/**
 * Whether this view's toolbar participates in the side rail. `"disabled"`
 * keeps the bar horizontal — per Apple, only the detail column of a split
 * view should go vertical, so sidebar/content columns opt out and leave the
 * rail to the tab bar (plus the detail column's own items).
 */
export type DuoToolbarVerticalBehavior = "automatic" | "disabled";

export const toolbarVerticalBehavior = (behavior: DuoToolbarVerticalBehavior = "automatic") =>
  createModifier("duoToolbarVerticalBehavior", { behavior });

/**
 * Which bar survives when the shared vertical rail runs out of room.
 * `"prefersTabBar"` (the system default: toolbar collapses into `···` first)
 * suits navigation-driven screens; `"prefersToolbarItems"` keeps actions
 * visible on task-driven screens and minimizes the tab bar instead.
 */
export type DuoToolbarVerticalCompressionBehavior = "automatic" | "prefersToolbarItems" | "prefersTabBar";

export const toolbarVerticalCompressionBehavior = (behavior: DuoToolbarVerticalCompressionBehavior = "automatic") =>
  createModifier("duoToolbarVerticalCompressionBehavior", { behavior });
