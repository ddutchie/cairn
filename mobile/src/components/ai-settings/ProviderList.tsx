import { View, Text, Pressable, Alert } from "react-native";
import { Check, Plus, Trash2 } from "lucide-react-native";
import { type Theme } from "@/theme";
import type { SavedProvider } from "@/chat/ai-config";
import type { AiSettingsStyles } from "./styles";
import { ConnectorLogo } from "@/components/ConnectorLogo";

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
  providerLogos,
  t,
  styles,
}: {
  providers: SavedProvider[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  providerLogos?: Record<string, { iconSvg?: string; brandColor?: string }>;
  t: Theme;
  styles: AiSettingsStyles;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Saved providers</Text>
      <View style={styles.providerChips}>
        {providers.map((p) => {
          const selected = p.id === activeId;
          // Match by communityId first; fall back to a normalized baseUrl so a
          // manually-added provider sharing an endpoint with a catalog entry
          // still shows its brand mark.
          const normUrl = p.baseUrl.toLowerCase().replace(/\/+$/, "");
          const logo = (p.communityId && providerLogos?.[p.communityId]) || providerLogos?.[normUrl];
          return (
            <Pressable
              key={p.id}
              style={[styles.providerChip, selected && styles.providerChipActive]}
              onPress={() => onSelect(p.id)}
            >
              {selected && <Check size={12} color={t.accentFg} />}
              {logo?.iconSvg ? (
                <ConnectorLogo iconSvg={logo.iconSvg} kind="service" color={logo.brandColor} size={12} />
              ) : null}
              <Text
                style={[styles.providerChipText, selected && styles.providerChipTextActive]}
                numberOfLines={1}
              >
                {p.name}
              </Text>
              {selected && providers.length > 1 && (
                <Pressable
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete provider ${p.name}`}
                  onPress={() =>
                    Alert.alert(
                      "Delete provider",
                      `Delete “${p.name}”? This can't be undone.`,
                      [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => onDelete(p.id) },
                      ],
                    )
                  }
                >
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
