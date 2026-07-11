import { useState, type ReactNode } from "react";
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
  fixedContent = false,
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
  /**
   * When true, size the `Host` to the explicit `containerStyle` frame instead of
   * `matchContents`. SwiftUI reserves a ~44pt min tap height for a `Menu` label,
   * so `matchContents` makes the Host taller than the icon and the glyph lands
   * off-centre inside a fixed-height row slot. A fixed frame lets SwiftUI centre
   * the label within a known box. Use when the trigger sits in a tight row (e.g.
   * the chat composer) and needs to line up with sibling buttons.
   */
  fixedContent?: boolean;
}) {
  // Bumped once when the native Host reports its content layout (see below) to
  // force a single re-layout so the trigger settles in the right position.
  const [layoutTick, setLayoutTick] = useState(0);

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
    // The SwiftUI Host measures its content asynchronously after mount, so on the
    // first paint the trigger can render mis-aligned within a flex row until some
    // later re-layout (keyboard/tab change) forces a remeasure. `onLayoutContent`
    // fires once the content is measured; bumping state then forces one RN
    // re-layout so the final position is correct without user interaction.
    //
    // `fixedContent`: use the explicit containerStyle frame (not matchContents) so
    // SwiftUI centres the label inside a known box — matchContents inherits the
    // Menu's ~44pt min tap height and shoves a small glyph off-centre in a tight
    // row. When false we keep matchContents (Host sizes to its content).
    return (
      <Host
        matchContents={!fixedContent}
        style={containerStyle}
        onLayoutContent={() => setLayoutTick((n) => (n === 0 ? 1 : n))}
      >
        <Menu
          key={layoutTick}
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
