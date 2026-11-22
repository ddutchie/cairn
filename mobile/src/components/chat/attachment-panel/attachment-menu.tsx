import { Image } from "expo-image";
import { Fragment, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Check, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react-native";
import { MENU, menuThumbSize, type Frame } from "./constants";
import { type, useTheme, withAlpha, useIsDark } from "@/theme";
import { LIQUID_GLASS } from "./glass";
import { MenuSlider } from "./menu-slider";
import type { LibraryPhoto } from "./use-photo-library";

export type MenuAction = "camera" | "photos" | "files";

/** One row of the `+` panel. */
export interface MenuRow {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** Current setting, shown dimmed at the trailing edge ("None", "3 on"). */
  value?: string;
  /** Shows a chevron: the row opens a screen or a list of choices. */
  more?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Tap. The panel closes first. Ignored when the row has `choices`. */
  onPress?: () => void;
  /**
   * Options picked inside the panel: tapping the row swaps the panel's rows for this
   * list, with a back row on top. (Native SwiftUI menus don't draw in the panel, which
   * sits in its own window over the keyboard.)
   */
  choices?: MenuChoice[];
  /** A choice was picked. The panel closes first. */
  onChoose?: (key: string) => void;
  /**
   * A stepped value set inside the panel: tapping the row shows a slider (and, with
   * `autoLabel`, a row to go back to the default). Changes apply as you slide; the
   * panel stays open.
   */
  slider?: MenuSliderSpec;
}

export interface MenuSliderSpec {
  min: number;
  max: number;
  step: number;
  /** Undefined: the default (`autoLabel`) is in use. */
  value: number | undefined;
  /** Where the thumb rests while the default is in use. */
  placeholder: number;
  format: (v: number) => string;
  onChange: (v: number | undefined) => void;
  /** Row under the slider that returns to the default ("Auto (model default)"). */
  autoLabel?: string;
}

export interface MenuChoice {
  key: string;
  label: string;
  selected?: boolean;
}

export interface MenuGroup {
  key: string;
  rows: MenuRow[];
}

export interface RecentStrip {
  photos: LibraryPhoto[];
  /** `from` is the thumbnail's frame within the menu, for the flight into the composer. */
  onPick: (photo: LibraryPhoto, from: Frame) => void;
}

export function AttachmentMenu({
  width,
  height,
  scrolls,
  groups,
  recent,
}: {
  width: number;
  height: number;
  /** The natural height didn't fit the window: the menu scrolls inside `height`. */
  scrolls: boolean;
  groups: MenuGroup[];
  /** Recent photos above the groups; absent hides the strip. */
  recent?: RecentStrip;
}) {
  const t = useTheme();
  const isLight = !useIsDark();
  // Panel is dark fallback when liquid glass unavailable, but light-translucent when available on iOS 26
  const useDarkText = isLight && LIQUID_GLASS;
  const fg = useDarkText ? t.textPrimary : "#FFFFFF";
  const dim = withAlpha(fg, 0.55);
  const hairline = withAlpha(fg, 0.1);
  const placeholder = withAlpha(fg, 0.08);
  const thumb = menuThumbSize(width);
  const scrollY = useRef(0);
  const shown = groups.filter((g) => g.rows.length > 0);
  // The row whose choices are showing in place of the groups (null: the groups).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const sub = openKey ? shown.flatMap((g) => g.rows).find((r) => r.key === openKey && (r.choices || r.slider)) : undefined;

  const rowBody = (row: MenuRow) => {
    const color = row.destructive ? t.danger : fg;
    return (
      <View style={[styles.row, { width }, row.disabled && styles.disabled]}>
        <row.Icon size={MENU.iconSize} color={color} strokeWidth={1.75} />
        <Text style={[styles.label, { color }]} numberOfLines={1}>
          {row.label}
        </Text>
        {row.value ? (
          <Text style={[styles.value, { color: dim }]} numberOfLines={1}>
            {row.value}
          </Text>
        ) : null}
        {row.more ? <ChevronRight size={16} color={dim} /> : null}
      </View>
    );
  };

  const renderRow = (row: MenuRow) => {
    return (
      <Pressable
        key={row.key}
        accessibilityRole="button"
        accessibilityLabel={row.value ? `${row.label}: ${row.value}` : row.label}
        accessibilityState={{ disabled: !!row.disabled }}
        disabled={row.disabled}
        onPress={row.choices || row.slider ? () => setOpenKey(row.key) : row.onPress}
      >
        {rowBody(row)}
      </Pressable>
    );
  };

  const separator = (key: string) => (
    <View key={key} style={styles.gap}>
      <View style={[styles.hairline, { backgroundColor: hairline }]} />
    </View>
  );

  // A row's choices: back row (the row's own name), then one row per choice, the
  // current one ticked where the icon sits.
  const subContent = sub ? (
    <Animated.View key={`sub-${sub.key}`} entering={FadeIn.duration(160)}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Back from ${sub.label}`} onPress={() => setOpenKey(null)}>
        <View style={[styles.row, { width }]}>
          <ChevronLeft size={MENU.iconSize} color={fg} strokeWidth={1.75} />
          <Text style={[styles.label, styles.subTitle, { color: fg }]} numberOfLines={1}>
            {sub.label}
          </Text>
        </View>
      </Pressable>
      {separator("sub-sep")}
      {sub.slider ? (
        <>
          <MenuSlider
            label={sub.label}
            min={sub.slider.min}
            max={sub.slider.max}
            step={sub.slider.step}
            value={sub.slider.value}
            placeholder={sub.slider.placeholder}
            format={sub.slider.format}
            onChange={sub.slider.onChange}
            fg={fg}
            accent={t.accent}
          />
          {sub.slider.autoLabel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={sub.slider.autoLabel}
              accessibilityState={{ selected: sub.slider.value == null }}
              onPress={() => sub.slider?.onChange(undefined)}
            >
              <View style={[styles.row, { width }]}>
                {sub.slider.value == null ? <Check size={MENU.iconSize} color={fg} strokeWidth={2} /> : <View style={styles.iconSpace} />}
                <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
                  {sub.slider.autoLabel}
                </Text>
              </View>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {(sub.choices ?? []).map((c) => (
        <Pressable
          key={c.key}
          accessibilityRole="button"
          accessibilityLabel={c.label}
          accessibilityState={{ selected: !!c.selected }}
          onPress={() => sub.onChoose?.(c.key)}
        >
          <View style={[styles.row, { width }]}>
            {c.selected ? <Check size={MENU.iconSize} color={fg} strokeWidth={2} /> : <View style={styles.iconSpace} />}
            <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
              {c.label}
            </Text>
          </View>
        </Pressable>
      ))}
    </Animated.View>
  ) : null;

  const content = subContent ?? (
    <>
      {recent ? (
        <View style={[styles.strip, { height: thumb, marginTop: MENU.stripInset - MENU.paddingVertical, marginBottom: MENU.stripBelow }]}>
          {Array.from({ length: MENU.stripCount }, (_, i) => {
            const photo = recent.photos[i];
            const box = { width: thumb, height: thumb, borderRadius: MENU.stripRadius, backgroundColor: placeholder };
            if (!photo) return <View key={`slot-${i}`} style={[styles.thumb, box]} />;
            return (
              <Pressable
                key={photo.id}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Attach recent photo ${i + 1}`}
                onPress={() =>
                  recent.onPick(photo, {
                    x: MENU.stripInset + i * (thumb + MENU.stripGap),
                    y: MENU.stripInset - scrollY.current,
                    w: thumb,
                    h: thumb,
                  })
                }
                style={[styles.thumb, box]}
              >
                <Image source={photo.id} recyclingKey={photo.id} contentFit="cover" cachePolicy="memory-disk" style={StyleSheet.absoluteFill} />
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {shown.map((group, gi) => (
        <Fragment key={group.key}>
          {gi > 0 ? separator(`sep-${group.key}`) : null}
          {group.rows.map(renderRow)}
        </Fragment>
      ))}
    </>
  );

  return (
    <View style={[styles.root, { width, height }]}>
      {scrolls || sub ? (
        <ScrollView
          style={StyleSheet.absoluteFill}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          scrollEventThrottle={32}
          onScroll={(e) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
          }}
        >
          {content}
        </ScrollView>
      ) : (
        <View style={styles.scrollContent}>{content}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", left: 0, top: 0 },
  scrollContent: { paddingVertical: MENU.paddingVertical },
  strip: { flexDirection: "row", gap: MENU.stripGap, paddingHorizontal: MENU.stripInset },
  thumb: { overflow: "hidden", borderCurve: "continuous" },
  row: {
    height: MENU.itemHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: MENU.iconInset,
    paddingRight: MENU.iconInset - 4,
  },
  disabled: { opacity: 0.4 },
  iconSpace: { width: MENU.iconSize, height: MENU.iconSize },
  subTitle: { fontWeight: "600" },
  label: {
    flex: 1,
    marginLeft: MENU.labelGap,
    fontSize: MENU.labelSize,
    letterSpacing: -0.2,
    fontWeight: "500",
  },
  value: { fontSize: type.body.fontSize, marginLeft: 8, maxWidth: 120 },
  gap: { height: MENU.groupGap, justifyContent: "center", paddingLeft: MENU.iconInset + MENU.iconSize + MENU.labelGap },
  hairline: { height: StyleSheet.hairlineWidth },
});
