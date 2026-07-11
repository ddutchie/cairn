import { type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Host, Menu, RNHostView } from "@expo/ui/swift-ui";
import { haptics } from "@/haptics";

/**
 * Reusable native (glass) tap-menu. Wraps a custom React Native `trigger` in the
 * `@expo/ui` `Host` → `Menu` → `RNHostView`-label pattern so the trigger button
 * morphs into a Liquid Glass menu on tap (iOS 26+). `children` are the menu
 * items — `@expo/ui/swift-ui` `Button` / `Section` / `Divider` / nested `Menu`.
 *
 * On non-iOS there's no native menu, so the trigger falls back to a plain
 * `Pressable` that calls `onFallbackPress` (e.g. show an Alert / sheet).
 *
 * Example:
 *   <GlassMenu trigger={<MyIcon />} accessibilityLabel="More actions">
 *     <Button label="Rename" systemImage="pencil" onPress={rename} />
 *     <Button label="Delete" systemImage="trash" role="destructive" onPress={del} />
 *   </GlassMenu>
 */
export function GlassMenu({
  trigger,
  children,
  accessibilityLabel,
  onFallbackPress,
  triggerStyle,
  containerStyle,
  hitSlop = 10,
  disabled = false,
}: {
  /** The always-visible view that opens the menu when tapped. */
  trigger: ReactNode;
  /** Menu items (`@expo/ui/swift-ui` Button/Section/Divider/Menu). */
  children: ReactNode;
  accessibilityLabel?: string;
  /** Called on tap when the native menu isn't available (non-iOS). */
  onFallbackPress?: () => void;
  triggerStyle?: StyleProp<ViewStyle>;
  /**
   * Style for the OUTERMOST element (the `Host` on iOS / fallback `Pressable`
   * root) — i.e. the actual flex child when GlassMenu sits in a flex row. Use
   * this for `alignSelf` / margins so layout applies to the flex item itself,
   * not the inner trigger (which the parent flexbox can't see).
   */
  containerStyle?: StyleProp<ViewStyle>;
  hitSlop?: number;
  /** When true, the trigger is inert and the menu can't be opened. */
  disabled?: boolean;
}) {
  // Disabled: render the trigger only, no menu / no tap handling. Works on all
  // platforms and keeps callers from having to swap components while busy.
  if (disabled) {
    return (
      <View
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: true }}
        style={[styles.trigger, containerStyle, triggerStyle]}
      >
        {trigger}
      </View>
    );
  }

  if (Platform.OS === "ios") {
    // If the caller pins an explicit width+height on the container, give the Host
    // that fixed frame and DON'T use matchContents — matchContents measures the
    // SwiftUI content asynchronously after mount, which leaves the trigger
    // mis-centred until a re-layout (e.g. a tab change) forces a remeasure. A
    // fixed frame lays out correctly on first paint.
    const flat = StyleSheet.flatten(containerStyle) as ViewStyle | undefined;
    const hasFixedSize = flat != null && typeof flat.width === "number" && typeof flat.height === "number";
    return (
      <Host matchContents={!hasFixedSize} style={containerStyle}>
        <Menu
          label={
            <RNHostView matchContents>
              <Pressable
                hitSlop={hitSlop}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                onPress={() => haptics.selection()}
                style={[styles.trigger, triggerStyle]}
              >
                {trigger}
              </Pressable>
            </RNHostView>
          }
        >
          {children}
        </Menu>
      </Host>
    );
  }

  return (
    <Pressable
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        haptics.selection();
        onFallbackPress?.();
      }}
      style={[styles.trigger, containerStyle, triggerStyle]}
    >
      <View>{trigger}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: { alignItems: "center", justifyContent: "center" },
});
