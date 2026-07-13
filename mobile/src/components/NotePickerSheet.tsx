import { useMemo } from "react";
import { View, Text, Pressable, FlatList, StyleSheet } from "react-native";
import { Check, Folder, FolderOpen } from "lucide-react-native";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { ProjectIcon } from "./ProjectIcon";
import { BottomSheet, BottomSheetHeader } from "./BottomSheet";

/** One selectable option in the picker. */
export interface PickerOption {
  /** The value returned via onSelect (project id, or folder path). */
  value: string;
  /** Row label. */
  label: string;
  /**
   * For the "project" variant: the project's Lucide icon NAME (e.g. "Rocket") —
   * NOT an emoji. Rendered via ProjectIcon so it matches the icon shown
   * everywhere else. Ignored by the other variants.
   */
  icon?: string | null;
}

/**
 * A bottom-anchored single-select sheet used by the note long-press menu to
 * pick a target — either another project ("Move to project") or a folder
 * ("Move to folder"). Selecting a row commits immediately (single-select, no
 * Done button) and closes; this mirrors the desktop MoveNoteModal / folder
 * picker, which also commit on tap.
 */
export function NotePickerSheet({
  visible,
  title,
  options,
  selectedValue,
  emptyText,
  variant = "plain",
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: PickerOption[];
  /** Current value — shown with a check and skipped-as-target styling. */
  selectedValue?: string;
  emptyText: string;
  /** "folder" shows a folder glyph; "project" renders each option's Lucide icon; "plain" shows no leading glyph. */
  variant?: "plain" | "folder" | "project";
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="70%">
      <BottomSheetHeader title={title} onCancel={onClose} />

      {options.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : (
        <FlatList
          data={options}
          keyExtractor={(o) => o.value}
          style={styles.list}
          renderItem={({ item }) => {
            const on = item.value === selectedValue;
            return (
              <Pressable
                style={[styles.row, on && { backgroundColor: withAlpha(t.accent, 0.1), opacity: 0.6 }]}
                // The current project/folder is where the note already lives —
                // selecting it is a no-op, so disable it (and show it as such).
                disabled={on}
                onPress={() => { if (!on) onSelect(item.value); }}
              >
                {variant === "folder" ? (
                  on ? (
                    <FolderOpen size={16} color={t.accent} />
                  ) : (
                    <Folder size={16} color={t.textTertiary} />
                  )
                ) : variant === "project" ? (
                  <ProjectIcon name={item.icon} size={16} color={on ? t.accent : t.textSecondary} />
                ) : (
                  <View style={styles.iconSlot} />
                )}
                <Text style={styles.name} numberOfLines={1}>
                  {item.label}
                </Text>
                {on && <Check size={18} color={t.accent} />}
              </Pressable>
            );
          }}
        />
      )}
    </BottomSheet>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 10, paddingBottom: 6 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 10,
    },
    iconSlot: { width: 16 },
    name: { flex: 1, ...typeScale.body, color: t.textPrimary },
    empty: { color: t.textTertiary, textAlign: "center", padding: 28, ...typeScale.caption },
  });
}
