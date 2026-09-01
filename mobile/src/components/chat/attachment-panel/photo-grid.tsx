import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Image } from "expo-image";
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { BOTTOM_BAR, COLORS, DURATION, EASE_FADE, GRID, GUTTER, SPRING, type Frame } from "./constants";
import { Glass } from "./glass";
import type { LibraryPhoto, LibraryStatus } from "./use-photo-library";

function slotSize(width: number) {
  return width / GRID.columns;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface CellProps {
  photo: LibraryPhoto;
  slot: number;
  order: number;
  lifted: boolean;
  onPress: (photo: LibraryPhoto) => void;
}

const PhotoCell = memo(function PhotoCell({ photo, slot, order, lifted, onPress }: CellProps) {
  const selected = order > 0;
  const progress = useDerivedValue(() => withSpring(selected ? 1 : 0, SPRING.badge));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ scale: interpolate(progress.get(), [0, 1], [0.4, 1]) }],
  }));

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityState={{ selected }}
      onPress={() => onPress(photo)}
      style={{ width: slot, height: slot, opacity: lifted ? 0 : 1 }}
    >
      <View style={styles.cell}>
        <Image source={photo.id} recyclingKey={photo.id} contentFit="cover" cachePolicy="memory-disk" style={StyleSheet.absoluteFill} />
      </View>
      <Animated.View pointerEvents="none" style={[styles.badge, badgeStyle]}>
        <Text style={styles.badgeLabel}>{selected ? order : ""}</Text>
      </Animated.View>
    </Pressable>
  );
});

function ConfirmPill({ count, active, fade, onPress }: { count: number; active: boolean; fade: SharedValue<number>; onPress: () => void }) {
  const hasSelection = count > 0;
  const label = count === 1 ? "Add 1 photo" : `Add ${count} photos`;
  const swap = useDerivedValue(() => withTiming(hasSelection ? 1 : 0, { duration: DURATION.pill, easing: EASE_FADE }));
  const plain = useAnimatedStyle(() => ({ opacity: (1 - swap.get()) * fade.get() }));
  const tinted = useAnimatedStyle(() => ({ opacity: swap.get() * fade.get() }));
  const [labelWidth, setLabelWidth] = useState(0);
  const width = useSharedValue(0);
  useEffect(() => {
    if (!labelWidth) return;
    width.set(width.get() === 0 ? labelWidth : withSpring(labelWidth, SPRING.pill));
  }, [labelWidth, width]);
  const sizeStyle = useAnimatedStyle(() => ({ width: width.get() + BOTTOM_BAR.pillPaddingHorizontal * 2 }));

  return (
    <View pointerEvents="box-none" style={styles.pillSlot}>
      <Text numberOfLines={1} onLayout={(e) => setLabelWidth(e.nativeEvent.layout.width)} style={[styles.pillLabel, styles.pillSizer]}>
        {hasSelection ? label : "All Photos"}
      </Text>
      <AnimatedPressable accessibilityRole="button" accessibilityLabel={hasSelection ? label : "All photos"} disabled={!hasSelection} onPress={onPress} style={sizeStyle}>
        <Glass radius={BOTTOM_BAR.pillHeight / 2} active={active} duration={DURATION.crossfade / 1000} style={styles.pill}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.pillTint, tinted]} />
          <Animated.Text numberOfLines={1} style={[styles.pillLabel, styles.pillText, plain]}>
            All Photos
          </Animated.Text>
          <Animated.Text numberOfLines={1} style={[styles.pillLabel, styles.pillText, tinted]}>
            {label}
          </Animated.Text>
        </Glass>
      </AnimatedPressable>
    </View>
  );
}

export interface PhotoGridHandle {
  measureCell: (id: string) => Frame | null;
}

export const PhotoGrid = forwardRef<PhotoGridHandle, { width: number; height: number; photos: LibraryPhoto[]; status: LibraryStatus; selected: string[]; lifting: boolean; onTogglePhoto: (photo: LibraryPhoto) => void }>(
  function PhotoGrid({ width, height, photos, status, selected, lifting, onTogglePhoto }, handle) {
    const slot = slotSize(width);
    const listRef = useRef<FlashListRef<LibraryPhoto>>(null);

    useImperativeHandle(
      handle,
      () => ({
        measureCell: (id) => {
          const list = listRef.current;
          const index = photos.findIndex((photo) => photo.id === id);
          if (!list || index < 0) return null;
          const layout = list.getLayout(index);
          if (!layout) return null;
          const scrolled = list.getAbsoluteLastScrollOffset() - list.getFirstItemOffset();
          return { x: layout.x, y: layout.y - scrolled, w: layout.width - GRID.gap, h: layout.height - GRID.gap };
        },
      }),
      [photos],
    );

    return (
      <View style={[styles.root, { width, height }]}>
        {status === "ready" ? (
          <FlashList
            ref={listRef}
            data={photos}
            numColumns={GRID.columns}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <PhotoCell photo={item} slot={slot} order={selected.indexOf(item.id) + 1} lifted={lifting && selected.includes(item.id)} onPress={onTogglePhoto} />
            )}
            extraData={`${selected.join()}|${lifting}`}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            ListFooterComponent={<View style={styles.footer} />}
            showsVerticalScrollIndicator={false}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>
              {status === "loading" ? "Loading photos…" : status === "empty" ? "No photos on this device." : "Photo access is off. Turn it on in Settings to try this demo."}
            </Text>
          </View>
        )}
      </View>
    );
  },
);

export function PhotoGridBar({
  width,
  selected,
  active,
  fade,
  onBack,
  onConfirm,
}: {
  width: number;
  selected: string[];
  active: boolean;
  fade: SharedValue<number>;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const contentStyle = useAnimatedStyle(() => ({ opacity: fade.get() }));
  return (
    <View pointerEvents={active ? "box-none" : "none"} style={[styles.bar, { width }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to menu" onPress={onBack}>
        <Glass radius={BOTTOM_BAR.backSize / 2} active={active} duration={DURATION.crossfade / 1000} style={styles.back}>
          <Animated.View style={contentStyle}>
            <Text style={{ color: COLORS.text, fontSize: 20 }}>‹</Text>
          </Animated.View>
        </Glass>
      </Pressable>
      <ConfirmPill count={selected.length} active={active} fade={fade} onPress={onConfirm} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", left: 0, top: 0 },
  cell: {
    position: "absolute",
    left: 0,
    top: 0,
    right: GRID.gap,
    bottom: GRID.gap,
    borderRadius: GRID.cellRadius,
    overflow: "hidden",
    backgroundColor: "#141414",
  },
  badge: {
    position: "absolute",
    right: GRID.badgeInset + GRID.gap,
    bottom: GRID.badgeInset + GRID.gap,
    width: GRID.badgeSize,
    height: GRID.badgeSize,
    borderRadius: GRID.badgeSize / 2,
    borderWidth: GRID.badgeRing,
    borderColor: COLORS.text,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.accent,
  },
  badgeLabel: { color: COLORS.text, fontSize: GRID.badgeLabelSize, fontWeight: "600", fontVariant: ["tabular-nums"] },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 48 },
  placeholderText: { color: COLORS.placeholder, fontSize: 15, textAlign: "center" },
  bar: {
    position: "absolute",
    left: GUTTER,
    bottom: GUTTER + BOTTOM_BAR.inset,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: BOTTOM_BAR.inset,
  },
  footer: { height: BOTTOM_BAR.inset + BOTTOM_BAR.pillHeight + 24 },
  back: { width: BOTTOM_BAR.backSize, height: BOTTOM_BAR.backSize, alignItems: "center", justifyContent: "center" },
  pillSlot: { flex: 1, alignItems: "flex-end" },
  pill: { height: BOTTOM_BAR.pillHeight, alignItems: "center", justifyContent: "center" },
  pillLabel: { color: COLORS.text, fontSize: BOTTOM_BAR.pillLabelSize, fontWeight: "600", fontVariant: ["tabular-nums"] },
  pillTint: { borderRadius: BOTTOM_BAR.pillHeight / 2, backgroundColor: COLORS.accentGlass },
  pillSizer: { position: "absolute", left: 0, opacity: 0 },
  pillText: { position: "absolute", left: 0, right: 0, textAlign: "center" },
});
