import { Image } from "expo-image";
import { forwardRef, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInput as TextInputType } from "react-native";
import { X, Plus, Mic } from "lucide-react-native";
import Animated, { Extrapolation, FadeOut, interpolate, LinearTransition, useAnimatedReaction, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { COLORS, COMPOSER, COMPOSER_STRIP_HEIGHT, DURATION, GUTTER } from "./constants";
import { Glass } from "./glass";
import type { LibraryPhoto } from "./use-photo-library";

interface ThumbnailProps {
  photo: LibraryPhoto;
  hidden: boolean;
  onRemove: (id: string) => void;
}

function Thumbnail({ photo, hidden, onRemove }: ThumbnailProps) {
  return (
    <Animated.View exiting={FadeOut.duration(DURATION.crossfade)} layout={LinearTransition.duration(DURATION.attach)} style={[styles.thumb, hidden && styles.thumbHidden]}>
      <Image source={photo.id} recyclingKey={photo.id} contentFit="cover" cachePolicy="memory-disk" style={StyleSheet.absoluteFill} />
      <Pressable accessibilityRole="button" accessibilityLabel="Remove attachment" hitSlop={10} onPress={() => onRemove(photo.id)} style={styles.remove}>
        <X size={11} color={COLORS.text} />
      </Pressable>
    </Animated.View>
  );
}

export interface ComposerProps {
  attachments: LibraryPhoto[];
  strip: SharedValue<number>;
  plusOut: SharedValue<number>;
  pendingIds: string[];
  onPlusPress: () => void;
  onRemove: (id: string) => void;
}

export const Composer = forwardRef<TextInputType, ComposerProps>(function Composer({ attachments, strip, plusOut, pendingIds, onPlusPress, onRemove }, ref) {
  const hasAttachments = attachments.length > 0;

  const plusStyle = useAnimatedStyle(() => ({
    opacity: interpolate(plusOut.get(), [0, 0.75], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateX: plusOut.get() * COMPOSER.plusSlide }],
  }));

  const [retained, setRetained] = useState(attachments);
  useEffect(() => {
    if (hasAttachments) setRetained(attachments);
  }, [attachments, hasAttachments]);

  useAnimatedReaction(
    () => strip.get() === 0,
    (shut, wasShut) => {
      if (shut && wasShut === false) scheduleOnRN(setRetained, [] as LibraryPhoto[]);
    },
  );

  const stripStyle = useAnimatedStyle(() => ({ height: strip.get() * COMPOSER_STRIP_HEIGHT }));

  return (
    <Glass radius={COMPOSER.radius} interactive={false} fallbackTint={COLORS.surface} style={styles.root}>
      <Animated.View style={[styles.strip, stripStyle]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none" style={styles.stripScroll} contentContainerStyle={styles.stripContent}>
          {retained.map((photo) => (
            <Thumbnail key={photo.id} photo={photo} hidden={pendingIds.includes(photo.id)} onRemove={onRemove} />
          ))}
        </ScrollView>
      </Animated.View>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Add attachment" hitSlop={12} onPress={onPlusPress} style={styles.plus}>
          <Animated.View style={plusStyle}>
            <Plus size={COMPOSER.plusSize} color={COLORS.text} />
          </Animated.View>
        </Pressable>
        <TextInput ref={ref} placeholder="Ask Cairn" placeholderTextColor={COLORS.placeholder} keyboardAppearance="dark" multiline={false} style={styles.field} />
        <Pressable accessibilityRole="button" accessibilityLabel="Dictate" hitSlop={10}>
          <Mic size={COMPOSER.micSize} color={COLORS.text} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={hasAttachments ? "Send" : "Voice mode"} style={styles.action}>
          <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: COLORS.background, fontSize: 16, fontWeight: "700" }}>{hasAttachments ? "↑" : "≋"}</Text>
          </View>
        </Pressable>
      </View>
    </Glass>
  );
});

const styles = StyleSheet.create({
  root: { marginHorizontal: GUTTER },
  strip: { overflow: "hidden", borderTopLeftRadius: COMPOSER.radius - COMPOSER.stripPaddingTop, borderTopRightRadius: COMPOSER.radius - COMPOSER.stripPaddingTop },
  stripScroll: { position: "absolute", left: 0, right: 0, top: COMPOSER.stripPaddingTop, height: COMPOSER.thumbSize },
  stripContent: { paddingLeft: COMPOSER.stripPaddingTop, gap: COMPOSER.thumbGap },
  thumb: { width: COMPOSER.thumbSize, height: COMPOSER.thumbSize, borderRadius: COMPOSER.thumbRadius, overflow: "hidden", backgroundColor: "#141414" },
  thumbHidden: { opacity: 0 },
  row: { height: COMPOSER.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: COMPOSER.rowPaddingLeft, paddingRight: 9, gap: 10 },
  plus: { width: COMPOSER.plusHit, alignItems: "center" },
  field: { flex: 1, color: COLORS.text, fontSize: COMPOSER.fieldSize, padding: 0 },
  remove: { position: "absolute", top: COMPOSER.removeBadgeInset, right: COMPOSER.removeBadgeInset, width: COMPOSER.removeBadge, height: COMPOSER.removeBadge, borderRadius: COMPOSER.removeBadge / 2, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" },
  action: { width: COMPOSER.actionSize, height: COMPOSER.actionSize, borderRadius: COMPOSER.actionSize / 2, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.text },
});
