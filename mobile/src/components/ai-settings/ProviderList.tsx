import { useState, useSyncExternalStore } from "react";
import { View, Text, Pressable, Alert, ScrollView } from "react-native";
import { Check, Plus, Trash2, ChevronDown, Server } from "lucide-react-native";
import { type Theme } from "@/theme";
import type { SavedProvider } from "@/chat/ai-config";
import type { AiSettingsStyles } from "./styles";
import { ConnectorLogo } from "@/components/ConnectorLogo";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { getOrFetchLogoSvg, subscribeModelCatalog, getModelCatalogVersion } from "@/chat/models-dev";

/** A resolved brand mark for a saved provider (see AiSettingsForm). */
export type ResolvedProviderLogo =
  | { kind: "iconSvg"; iconSvg: string; brandColor?: string }
  | { kind: "slug"; slug: string };

/** The logo glyph for a provider (community SVG / models.dev slug / fallback). */
function ProviderGlyph({ logo, size, color }: { logo?: ResolvedProviderLogo; size?: number; color?: string }) {
  const s = size ?? 14;
  if (logo?.kind === "iconSvg") {
    return <ConnectorLogo iconSvg={logo.iconSvg} kind="service" color={logo.brandColor} size={s} />;
  }
  if (logo?.kind === "slug") {
    // Fetch + cache the models.dev SVG for this slug and render it on the SAME
    // fixed light chip as community icons, instead of the raw theme-tinted
    // glyph. Re-renders via the catalog version subscription once the SVG lands.
    const svg = getOrFetchLogoSvg(logo.slug);
    return svg ? <ConnectorLogo iconSvg={svg} kind="service" size={s} /> : null;
  }
  return <Server size={s} color={color ?? "#9e9a94"} />;
}

/**
 * Saved OpenAI-compatible providers switcher — a dropdown mirroring the desktop
 * provider manager: a collapsed trigger showing the active provider (logo +
 * name + chevron) opens a sheet listing every saved connection (logo, name,
 * model sublabel, check on the active one), with Add and Delete. Selecting makes
 * that provider active and loads its endpoint/key/model into the fields below.
 * Applies only to the OpenAI-compatible backend.
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
  // logos pop in on the trigger/rows (they fall back to the generic glyph meanwhile).
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const [open, setOpen] = useState(false);
  const active = providers.find((p) => p.id === activeId) ?? null;

  const confirmDelete = (p: SavedProvider) => {
    Alert.alert("Delete provider", `Delete “${p.name}”? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDelete(p.id) },
    ]);
  };

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Saved providers</Text>
      <Pressable
        style={[styles.fieldInput, styles.modelTrigger, open && styles.modelTriggerOpen]}
        onPress={() => {
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="Choose saved provider"
      >
        <ProviderGlyph logo={active ? providerLogos?.[active.id] : undefined} size={14} />
        <Text style={styles.modelTriggerText} numberOfLines={1}>
          {active ? active.name : "No saved providers"}
        </Text>
        <ChevronDown size={14} color={t.textTertiary} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
      </Pressable>
      <Text style={styles.compatHint}>
        Save multiple endpoints (OpenAI, OpenRouter, a local server…) and switch between them.
        The active provider fills the fields below.
      </Text>

      <BottomSheet visible={open} onClose={() => setOpen(false)} maxHeight="70%" avoidKeyboard>
        <BottomSheetHeader
          title="Saved providers"
          onCancel={() => setOpen(false)}
          onDone={() => setOpen(false)}
        />
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody}>
          {providers.length === 0 && (
            <Text style={styles.compatHint}>No saved providers yet — tap Add to create one.</Text>
          )}
          {providers.map((p) => {
            const selected = p.id === activeId;
            return (
              <Pressable
                key={p.id}
                style={[styles.personalityRow, selected && styles.personalityRowActive]}
                onPress={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Provider ${p.name}`}
              >
                <View style={styles.personalityRowHeader}>
                  <View style={styles.personalityRowMain}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <ProviderGlyph logo={providerLogos?.[p.id]} size={16} />
                      <Text style={styles.navRowTitle} numberOfLines={1}>{p.name}</Text>
                    </View>
                    <Text style={styles.navRowSub} numberOfLines={1}>
                      {p.model}
                    </Text>
                  </View>
                  {selected && <Check size={16} color={t.accent} />}
                  {providers.length > 1 && (
                    <Pressable
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete provider ${p.name}`}
                      onPress={() => confirmDelete(p)}
                    >
                      <Trash2 size={14} color={t.textTertiary} />
                    </Pressable>
                  )}
                </View>
              </Pressable>
            );
          })}

          <Pressable style={styles.providerAddChip} onPress={onAdd}>
            <Plus size={14} color={t.accent} />
            <Text style={styles.providerAddText}>Add provider</Text>
          </Pressable>
        </ScrollView>
      </BottomSheet>
    </View>
  );
}
