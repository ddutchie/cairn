import { Text, Pressable } from "react-native";
import { Check, type LucideIcon } from "lucide-react-native";
import { type Theme } from "@/theme";
import type { AiSettingsStyles } from "./styles";

/** A single segmented-control button (provider / reasoning-effort chooser). */
export function SegmentButton({
  label,
  icon: Icon,
  selected,
  onPress,
  t,
  styles,
}: {
  label: string;
  icon?: LucideIcon;
  selected: boolean;
  onPress: () => void;
  t: Theme;
  styles: AiSettingsStyles;
}) {
  return (
    <Pressable
      style={[styles.segmentBtn, selected && styles.segmentBtnActive]}
      onPress={onPress}
    >
      {selected ? (
        <Check size={13} color={t.accentFg} />
      ) : Icon ? (
        <Icon size={13} color={t.textSecondary} />
      ) : null}
      <Text style={[styles.segmentText, selected && styles.segmentTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
