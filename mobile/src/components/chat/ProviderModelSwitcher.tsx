/**
 * ProviderModelSwitcher — the "who am I talking to?" chip above the chat input.
 *
 * Shows the active provider · model and opens a bottom sheet to switch provider
 * (saved OpenAI-compatible providers + on-device Apple + built-in Rork) and pick
 * a model for the active OpenAI-compatible provider on the fly — mirroring the
 * desktop provider·model picker without leaving the chat tab.
 *
 * Config edits go through the same ai-config helpers the AI settings form uses
 * (selectSavedProvider / setProviderPref / setOpenAIEndpoint), so the chat
 * screen's focus re-check picks up the change on the next send.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { ChevronDown, Server, Apple as AppleIcon, Brain, Check } from "lucide-react-native";
import { useTheme, type as typeScale } from "@/theme";
import { haptics } from "@/haptics";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import {
  getProviderPref,
  setProviderPref,
  getActiveProvider,
  getActiveProviderId,
  getOpenAIModel,
  setOpenAIEndpoint,
  selectSavedProvider,
  listSavedProviders,
  getProviderApiKey,
  type SavedProvider,
} from "@/chat/ai-config";
import { isRorkAvailable } from "@/chat/providers/rork";
import { isAppleProviderAvailable } from "@/chat/providers/apple";
import { listModels } from "@/chat/providers/openai";

export function ProviderModelSwitcher() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => getActiveProviderId());
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const rorkAvailable = isRorkAvailable();
  const appleAvailable = isAppleProviderAvailable();

  const pref = getProviderPref(rorkAvailable);
  const activeProvider = getActiveProvider();
  const providerName = activeProvider?.name ?? "OpenAI";
  const modelLabel = pref === "rork" ? "Rork" : pref === "apple" ? "On-device" : getOpenAIModel() || "—";

  const openSheet = useCallback(async () => {
    setOpen(true);
    haptics.selection();
    const saved = await listSavedProviders();
    setProviders(saved);
    setActiveId(getActiveProviderId());
    // Fetch the active OpenAI-compatible provider's models when the sheet opens.
    if (getProviderPref(isRorkAvailable()) === "openai") {
      const active = getActiveProvider();
      const key = active ? await getProviderApiKey(active.id) : null;
      if (active && key) {
        setLoadingModels(true);
        setModelsError(null);
        try {
          setModels(await listModels(active.baseUrl, key));
        } catch (err) {
          setModels([]);
          setModelsError(err instanceof Error ? err.message : "Couldn't load models");
        } finally {
          setLoadingModels(false);
        }
      } else {
        setModels([]);
      }
    }
  }, []);

  const pickProvider = (id: string) => {
    selectSavedProvider(id);
    setActiveId(id);
    setOpen(false);
  };
  const pickBuiltin = (next: "apple" | "rork") => {
    setProviderPref(next);
    setOpen(false);
  };
  const pickModel = (model: string) => {
    const active = getActiveProvider();
    if (active) setOpenAIEndpoint(active.baseUrl, model, active.contextLimit);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        onPress={() => void openSheet()}
        accessibilityRole="button"
        accessibilityLabel="Switch provider or model"
        style={styles.chip}
      >
        <Server size={11} color={t.textTertiary} />
        <Text style={styles.chipText} numberOfLines={1}>
          {providerName}
        </Text>
        <Text style={styles.chipDot}>·</Text>
        <Text style={[styles.chipText, styles.chipModel]} numberOfLines={1}>
          {modelLabel}
        </Text>
        <ChevronDown size={12} color={t.textTertiary} />
      </Pressable>

      <BottomSheet visible={open} onClose={() => setOpen(false)} maxHeight="80%" avoidKeyboard>
        <BottomSheetHeader title="Provider & model" onCancel={() => setOpen(false)} />
        <ScrollView style={{ maxHeight: "72%" }} contentContainerStyle={styles.body}>
          {/* Provider list — every connected provider + built-in options */}
          <Text style={styles.sectionLabel}>Provider</Text>
          {appleAvailable && (
            <Row
              title="On-device (Apple Intelligence)"
              sub="Private Cloud Compute / on-device model"
              icon={<AppleIcon size={16} color={t.textSecondary} />}
              active={pref === "apple"}
              onPress={() => pickBuiltin("apple")}
              t={t}
            />
          )}
          {rorkAvailable && (
            <Row
              title="Rork"
              sub="Built-in assistant endpoint"
              icon={<Brain size={16} color={t.textSecondary} />}
              active={pref === "rork"}
              onPress={() => pickBuiltin("rork")}
              t={t}
            />
          )}
          {providers.map((p) => (
            <Row
              key={p.id}
              title={p.name || p.id}
              sub={p.baseUrl}
              icon={<Server size={16} color={t.textSecondary} />}
              active={pref === "openai" && p.id === activeId}
              onPress={() => pickProvider(p.id)}
              t={t}
            />
          ))}

          {/* Model list for the active OpenAI-compatible provider */}
          {pref === "openai" && activeProvider && (
            <>
              <Text style={[styles.sectionLabel, styles.modelSection]}>Model</Text>
              {loadingModels ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={t.accent} />
                </View>
              ) : modelsError ? (
                <Text style={styles.hint}>{modelsError} — current model still works.</Text>
              ) : models.length === 0 ? (
                <Text style={styles.hint}>No models listed — the current one still works.</Text>
              ) : (
                models.map((m) => (
                  <Row
                    key={m}
                    title={m}
                    icon={<Server size={16} color={t.textSecondary} />}
                    active={m === getOpenAIModel()}
                    onPress={() => pickModel(m)}
                    t={t}
                  />
                ))
              )}
            </>
          )}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

function Row({
  title,
  sub,
  icon,
  active,
  onPress,
  t,
}: {
  title: string;
  sub?: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
  t: ReturnType<typeof useTheme>;
}) {
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <Pressable
      style={[styles.row, active && styles.rowActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      {icon}
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text style={styles.rowSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {active && <Check size={16} color={t.accent} />}
    </Pressable>
  );
}

function makeStyles(t: ReturnType<typeof useTheme>) {
  return {
    chip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 5,
      alignSelf: "center" as const,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 999,
      paddingVertical: 5,
      paddingHorizontal: 10,
      marginBottom: 6,
    },
    chipText: { ...typeScale.caption, color: t.textSecondary, maxWidth: 150 },
    chipModel: { ...typeScale.caption, color: t.textPrimary, fontFamily: "monospace" },
    chipDot: { color: t.textTertiary },
    body: { paddingHorizontal: 18, paddingVertical: 8, gap: 6 },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary, marginTop: 6 },
    modelSection: { marginTop: 16 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    rowActive: { borderColor: t.accent },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...typeScale.control, color: t.textPrimary },
    rowSub: { ...typeScale.caption, color: t.textSecondary },
    loadingRow: { alignItems: "center" as const, paddingVertical: 12 },
    hint: { ...typeScale.caption, color: t.textSecondary, paddingVertical: 8 },
  };
}
