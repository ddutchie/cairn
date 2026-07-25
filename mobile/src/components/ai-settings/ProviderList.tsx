import { View, Text, Pressable } from "react-native";
import { Check, Plus, Trash2 } from "lucide-react-native";
import { type Theme } from "@/theme";
import type { SavedProvider } from "@/chat/ai-config";
import type { AiSettingsStyles } from "./styles";

/**
 * Saved OpenAI-compatible providers switcher: a row of selectable chips (one per
 * saved connection) plus an "Add" chip. Selecting a chip makes that provider
 * active and loads its endpoint/key/model into the fields below; the trash icon
 * on the active chip deletes it. Applies only to the OpenAI-compatible backend.
 */
export function ProviderList({
  providers,
  activeId,
  onSelect,
  onAdd,
  onDelete,
  t,
  styles,
}: {
  providers: SavedProvider[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  t: Theme;
  styles: AiSettingsStyles;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Saved providers</Text>
      <View style={styles.providerChips}>
        {providers.map((p) => {
          const selected = p.id === activeId;
          return (
            <Pressable
              key={p.id}
              style={[styles.providerChip, selected && styles.providerChipActive]}
              onPress={() => onSelect(p.id)}
            >
              {selected && <Check size={12} color={t.accentFg} />}
              <Text
                style={[styles.providerChipText, selected && styles.providerChipTextActive]}
                numberOfLines={1}
              >
                {p.name}
              </Text>
              {selected && providers.length > 1 && (
                <Pressable hitSlop={8} onPress={() => onDelete(p.id)}>
                  <Trash2 size={12} color={t.accentFg} />
                </Pressable>
              )}
            </Pressable>
          );
        })}
        <Pressable style={styles.providerAddChip} onPress={onAdd}>
          <Plus size={13} color={t.accent} />
          <Text style={styles.providerAddText}>Add</Text>
        </Pressable>
      </View>
      <Text style={styles.compatHint}>
        Save multiple endpoints (OpenAI, OpenRouter, a local server…) and switch between them.
        The active provider fills the fields below.
      </Text>
    </View>
  );
}
