import { View, Text, Pressable, Alert } from "react-native";
import { Check, Plus, Trash2 } from "lucide-react-native";
import { useSyncExternalStore } from "react";
import { type Theme } from "@/theme";
import type { SavedProvider } from "@/chat/ai-config";
import type { AiSettingsStyles } from "./styles";
import { ConnectorLogo } from "@/components/ConnectorLogo";
import { getOrFetchLogoSvg, subscribeModelCatalog, getModelCatalogVersion } from "@/chat/models-dev";

/** A resolved brand mark for a saved provider (see AiSettingsForm). */
export type ResolvedProviderLogo =
  | { kind: "iconSvg"; iconSvg: string; brandColor?: string }
  | { kind: "slug"; slug: string };

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
  providerLogos?: Record<string, ResolvedProviderLogo>;
  t: Theme;
  styles: AiSettingsStyles;
}) {
  // Re-render when a lazily-fetched models.dev provider SVG lands so slug-kind
  // logos pop in on the chip (they fall back to the generic glyph meanwhile).
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Saved providers</Text>
      <View style={styles.providerChips}>
        {providers.map((p) => {
          const selected = p.id === activeId;
          const logo = providerLogos?.[p.id];
          return (
            <Pressable
              key={p.id}
              style={[styles.providerChip, selected && styles.providerChipActive]}
              onPress={() => onSelect(p.id)}
            >
              {selected && <Check size={12} color={t.accentFg} />}
              {logo?.kind === "iconSvg" ? (
                <ConnectorLogo iconSvg={logo.iconSvg} kind="service" color={logo.brandColor} size={12} />
              ) : logo?.kind === "slug" ? (
                (() => {
                  // Fetch + cache the models.dev SVG for this slug and render it
                  // on the SAME fixed light chip as community icons, instead of
                  // the raw theme-tinted glyph. Re-renders via the catalog
                  // version subscription once the SVG lands.
                  const svg = getOrFetchLogoSvg(logo.slug);
                  return svg ? <ConnectorLogo iconSvg={svg} kind="service" size={12} /> : null;
                })()
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
