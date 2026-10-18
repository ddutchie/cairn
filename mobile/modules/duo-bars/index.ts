import { createModifier } from "@expo/ui/swift-ui/modifiers";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

interface DuoBarsNative {
  setVerticalBarCompression(mode: string): Promise<Record<string, unknown> | number | boolean>;
  preferTabBarCompression(): Promise<Record<string, unknown> | number | boolean>;
}

const native =
  Platform.OS === "ios" ? requireOptionalNativeModule<DuoBarsNative>("DuoBars") : null;

/** Whether the DuoBars native module is linked into this build. */
export function duoBarsAvailable(): boolean {
  return native != null;
}

/**
 * Asks the system rail which bar survives when room runs out — "tabBar"
 * (toolbar folds into ··· first, tabs preserved) or "barItems" (tab bar
 * minimizes first, toolbar preserved) — by stamping the owning view
 * controllers' `navigationItem.verticalBarCompressionBehavior`. Resolves the
 * native diagnostic dict (TEMP-DIAG shape). No-op off iOS / below 27.1.
 */
export async function setVerticalBarCompression(
  mode: "tabBar" | "barItems" | "automatic",
): Promise<Record<string, unknown> | false> {
  if (!native) return false;
  try {
    const result = await native.setVerticalBarCompression(mode);
    return result != null && typeof result === "object" ? (result as Record<string, unknown>) : false;
  } catch {
    return false;
  }
}

/** Back-compat alias; prefer setVerticalBarCompression. */
export async function preferTabBarCompression(): Promise<Record<string, unknown> | false> {
  return setVerticalBarCompression("tabBar");
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
