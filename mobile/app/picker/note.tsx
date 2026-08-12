import { useEffect, useMemo } from "react";
import { View, Text, Pressable, FlatList, StyleSheet } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Check, Folder, FolderOpen } from "lucide-react-native";
import { listProjects, listFolders } from "@/db/queries";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { ProjectIcon } from "@/components/ProjectIcon";
import { resolveSheetResult, discardSheetResult } from "@/lib/sheet-result";

/** One selectable option in the picker. */
export interface PickerOption {
  /** The value returned via the result (project id, or folder path). */
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
 * Native formSheet single-select route used by the note long-press menu to pick
 * a target — either another project ("Move to project") or a folder ("Move to
 * folder"). Selecting a row commits immediately (single-select, no Done button)
 * and closes; this mirrors the desktop MoveNoteModal / folder picker, which also
 * commit on tap.
 */
export default function NotePickerRoute() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const params = useLocalSearchParams<{
    resultKey?: string;
    title?: string;
    variant?: string;
    excludeProjectId?: string;
    projectId?: string;
    currentValue?: string;
    emptyText?: string;
  }>();

  const variant = params.variant === "folder" ? "folder" : params.variant === "project" ? "project" : "plain";
  const emptyText = params.emptyText || "Nothing to choose from.";

  const options = useMemo<PickerOption[]>(() => {
    if (variant === "project") {
      return listProjects()
        .filter((p) => p.id !== params.excludeProjectId)
        .map((p) => ({ value: p.id, label: p.name, icon: p.icon }));
    }
    if (variant === "folder") {
      const opts: PickerOption[] = [{ value: "", label: "Root" }];
      for (const f of listFolders(params.projectId ?? "")) {
        if (f) opts.push({ value: f, label: f });
      }
      return opts;
    }
    return [];
  }, [variant, params.excludeProjectId, params.projectId]);

  const pick = (value: string) => {
    if (params.resultKey) resolveSheetResult(params.resultKey, value);
    router.back();
  };

  // Dismissed without picking (swipe-down)? Drop the caller's pending handler.
  useEffect(() => {
    return () => {
      if (params.resultKey) discardSheetResult(params.resultKey);
    };
  }, [params.resultKey]);

  return (
    <>
      <Stack.Screen options={{ title: params.title || "Choose" }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button accessibilityLabel="Cancel" onPress={() => router.back()}>
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      {options.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : (
        <FlatList
          data={options}
          keyExtractor={(o) => o.value}
          style={[styles.list, { flex: 1 }]}
          contentInsetAdjustmentBehavior="automatic"
          renderItem={({ item }) => {
            const on = item.value === params.currentValue;
            return (
              <Pressable
                style={[styles.row, on && { backgroundColor: withAlpha(t.accent, 0.1), opacity: 0.6 }]}
                // The current project/folder is where the note already lives —
                // selecting it is a no-op, so disable it (and show it as such).
                disabled={on}
                onPress={() => {
                  if (!on) pick(item.value);
                }}
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
    </>
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
