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
        style={[styles.trigger, triggerStyle]}
      >
        {trigger}
      </View>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <Host matchContents>
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
      style={[styles.trigger, triggerStyle]}
    >
      <View>{trigger}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: { alignItems: "center", justifyContent: "center" },
});
