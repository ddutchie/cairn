import { Image } from "expo-image";
import { Fragment, useRef } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { Button as SUIButton } from "@expo/ui/swift-ui";
import { GlassMenu } from "@/components/GlassMenu";
import { MENU, menuThumbSize, type Frame } from "./constants";
import { useTheme, withAlpha, useIsDark } from "@/theme";
import { LIQUID_GLASS } from "./glass";
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
  /** Tap. With `choices` this is the fallback where there's no native menu (Android). */
  onPress?: () => void;
  /** iOS: the row opens a native menu of these instead of calling `onPress`. */
  choices?: { id: string; label: string; selected: boolean }[];
  onChoose?: (id: string) => void;
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
    if (row.choices && Platform.OS === "ios" && !row.disabled) {
      return (
        <GlassMenu key={row.key} trigger={rowBody(row)} accessibilityLabel={row.value ? `${row.label}: ${row.value}` : row.label} hitSlop={0}>
          {row.choices.map((c) => (
            <SUIButton key={c.id} label={c.label} systemImage={c.selected ? "checkmark" : undefined} onPress={() => row.onChoose?.(c.id)} />
          ))}
        </GlassMenu>
      );
    }
    return (
      <Pressable
        key={row.key}
        accessibilityRole="button"
        accessibilityLabel={row.value ? `${row.label}: ${row.value}` : row.label}
        accessibilityState={{ disabled: !!row.disabled }}
        disabled={row.disabled}
        onPress={row.onPress}
      >
        {rowBody(row)}
      </Pressable>
    );
  };

  const content = (
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
          {gi > 0 ? (
            <View style={styles.gap}>
              <View style={[styles.hairline, { backgroundColor: hairline }]} />
            </View>
          ) : null}
          {group.rows.map(renderRow)}
        </Fragment>
      ))}
    </>
  );

  return (
    <View style={[styles.root, { width, height }]}>
      {scrolls ? (
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
  label: {
    flex: 1,
    marginLeft: MENU.labelGap,
    fontSize: MENU.labelSize,
    letterSpacing: -0.2,
    fontWeight: "500",
  },
  value: { fontSize: 15, marginLeft: 8, maxWidth: 120 },
  gap: { height: MENU.groupGap, justifyContent: "center", paddingLeft: MENU.iconInset + MENU.iconSize + MENU.labelGap },
  hairline: { height: StyleSheet.hairlineWidth },
});
