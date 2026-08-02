import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Linking,
  Platform,
  Modal,
  TextInput,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { RefreshCw, Plus, ExternalLink, Server, Check, ArrowUpCircle } from "lucide-react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { fetchProvidersManifest, getCachedProvidersManifest } from "@/chat/providers-registry";
import {
  listSavedProviders,
  installCommunityProvider,
  type SavedProvider,
} from "@/chat/ai-config";
import type { RegistryProviderEntry } from "@cairn/shared/chat/registry-schema";
import { ConnectorLogo } from "@/components/ConnectorLogo";
import { SearchField } from "@/components/SearchField";

/** name + blurb + category + tags; `q` must already be lowercased + trimmed. */
function entryMatchesQuery(entry: RegistryProviderEntry, q: string): boolean {
  if (!q) return true;
  return (
    entry.definition.name.toLowerCase().includes(q) ||
    entry.blurb.toLowerCase().includes(q) ||
    (entry.category ?? "").toLowerCase().includes(q) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

/**
 * Browse Community Providers — install preset OpenAI-compatible AI providers
 * from the cairn-community `providers.json` catalog. Device-global + unsynced,
 * mirroring the Tools & Services screen. Installed providers join the shared
 * saved-providers list (managed in AI settings) but are NOT auto-selected.
 */
export default function ProvidersSettingsScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();

  const [providers, setProviders] = useState<RegistryProviderEntry[]>(
    () => getCachedProvidersManifest()?.providers ?? [],
  );
  const [saved, setSaved] = useState<SavedProvider[]>([]);
  const [loading, setLoading] = useState(() => getCachedProvidersManifest() === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  // Android has no Alert.prompt, so key-based installs use an in-app modal.
  const [keyPrompt, setKeyPrompt] = useState<{ entry: RegistryProviderEntry; value: string } | null>(null);

  const reloadSaved = useCallback(async () => {
    setSaved(await listSavedProviders());
  }, []);

  const loadRegistry = useCallback(async (force: boolean, active: () => boolean = () => true) => {
    const { manifest, error: err } = await fetchProvidersManifest(force);
    // Drop the result if the owning effect was torn down mid-flight — the
    // screen is unmounted or the refresh was superseded.
    if (!active()) return;
    setProviders(manifest?.providers ?? []);
    setError(err ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRegistry(false, () => !cancelled).finally(() => {
      if (!cancelled) setLoading(false);
    });
    void reloadSaved();
    return () => {
      cancelled = true;
    };
  }, [loadRegistry, reloadSaved]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    haptics.selection();
    void loadRegistry(true).finally(() => setRefreshing(false));
  }, [loadRegistry]);

  // communityId → installed row, for Added / Update state.
  const installedById = useMemo(() => {
    const map = new Map<string, SavedProvider>();
    for (const p of saved) if (p.communityId) map.set(p.communityId, p);
    return map;
  }, [saved]);

  const doInstall = useCallback(
    async (entry: RegistryProviderEntry, apiKey?: string) => {
      setBusyId(entry.id);
      try {
        await installCommunityProvider(entry, apiKey);
        haptics.success();
        await reloadSaved();
      } catch (e) {
        Alert.alert("Couldn't add provider", e instanceof Error ? e.message : "Unknown error.");
      } finally {
        setBusyId(null);
      }
    },
    [reloadSaved],
  );

  const onAdd = useCallback(
    (entry: RegistryProviderEntry) => {
      if (!entry.definition.needsApiKey) {
        void doInstall(entry);
        return;
      }
      const message = entry.definition.apiKeyUrl
        ? `Paste your API key. Get one at ${entry.definition.apiKeyUrl}.`
        : "Paste your API key for this provider.";
      if (Platform.OS === "ios") {
        Alert.prompt(
          `Add ${entry.definition.name}`,
          message,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Add", onPress: (v?: string) => void doInstall(entry, v ?? "") },
          ],
          "secure-text",
        );
      } else {
        setKeyPrompt({ entry, value: "" });
      }
    },
    [doInstall],
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [providers]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => providers.filter((p) => (!category || p.category === category) && entryMatchesQuery(p, q)),
    [providers, category, q],
  );

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: "AI Providers" }} />
      <Stack.Toolbar>
        <Stack.Toolbar.Button
          icon={ICON_CHECK}
          accessibilityLabel="Done"
          onPress={() => router.canGoBack() && router.back()}
        />
      </Stack.Toolbar>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionLabel}>Browse community</Text>
              <Pressable
                onPress={onRefresh}
                hitSlop={8}
                disabled={refreshing}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel="Refresh provider catalog"
              >
                <RefreshCw size={16} color={refreshing ? t.textTertiary : t.textSecondary} />
              </Pressable>
            </View>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search providers…" />
            {categories.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                <CategoryChip label="All" active={category === null} onPress={() => { haptics.selection(); setCategory(null); }} styles={styles} />
                {categories.map((cat) => (
                  <CategoryChip
                    key={cat}
                    label={cat}
                    active={category === cat}
                    onPress={() => { haptics.selection(); setCategory((cur) => (cur === cat ? null : cat)); }}
                    styles={styles}
                  />
                ))}
              </ScrollView>
            )}
          </View>

          <View style={styles.section}>
            {error && <Text style={styles.errorText}>{error}</Text>}
            {filtered.length === 0 && !error ? (
              <Text style={styles.sectionHint}>
                {providers.length === 0 ? "No community providers available." : "No providers match your search."}
              </Text>
            ) : (
              filtered.map((entry) => {
                const def = entry.definition;
                const installedRow = entry.id ? installedById.get(entry.id) : undefined;
                const installed = !!installedRow;
                // Same comparison semantics as isCommunityProviderOutdated, but
                // derived from the already-fetched installed row instead of a
                // per-entry list scan.
                const outdated =
                  !!installedRow &&
                  (installedRow.baseUrl !== def.baseUrl ||
                    installedRow.model !== (def.defaultModel ?? installedRow.model));
                const busy = busyId === entry.id;
                return (
                  <View key={entry.id} style={styles.row}>
                    <ConnectorLogo iconSvg={entry.iconSvg} kind="service" color={entry.brandColor} size={22} />
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle}>{def.name}</Text>
                      <Text style={styles.rowSub} numberOfLines={2}>{entry.blurb}</Text>
                      <Text style={styles.rowUrl} numberOfLines={1}>{def.baseUrl}</Text>
                      {!!def.apiKeyUrl && (
                        <Pressable
                          onPress={() => {
                            if (!def.apiKeyUrl) return;
                            void Linking.openURL(def.apiKeyUrl).catch(() => {
                              Alert.alert(
                                "Couldn't open link",
                                `Open ${def.apiKeyUrl} manually to get a key.`,
                              );
                            });
                          }}
                          style={styles.linkRow}
                          hitSlop={6}
                        >
                          <ExternalLink size={12} color={t.textTertiary} />
                          <Text style={styles.linkText}>Get a key</Text>
                        </Pressable>
                      )}
                    </View>
                    {installed && !outdated ? (
                      <View style={styles.installedTag}>
                        <Check size={14} color={t.success} />
                        <Text style={styles.installedText}>Added</Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => onAdd(entry)}
                        disabled={busy}
                        style={[styles.addBtn, outdated && styles.addBtnOutline]}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={`${outdated ? "Update" : "Add"} ${def.name}`}
                      >
                        {busy ? (
                          <ActivityIndicator color={outdated ? t.accent : t.accentFg} />
                        ) : (
                          <>
                            {outdated ? <ArrowUpCircle size={14} color={t.accent} /> : <Plus size={14} color={t.accentFg} />}
                            <Text style={[styles.addBtnText, outdated && styles.addBtnTextOutline]}>
                              {outdated ? "Update" : "Add"}
                            </Text>
                          </>
                        )}
                      </Pressable>
                    )}
                  </View>
                );
              })
            )}
          </View>

          <View style={styles.footer}>
            <Server size={12} color={t.textTertiary} />
            <Text style={styles.footerText}>
              Added providers join your saved list (AI settings). Keys are stored on this device only
              and never sync. Select one there to use it.
            </Text>
          </View>
        </ScrollView>
      )}

      {/* Android API-key prompt (iOS uses the native Alert.prompt). */}
      <Modal
        visible={keyPrompt !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyPrompt(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add {keyPrompt?.entry.definition.name}</Text>
            <Text style={styles.modalMessage}>
              {keyPrompt?.entry.definition.apiKeyUrl
                ? `Paste your API key. Get one at ${keyPrompt.entry.definition.apiKeyUrl}.`
                : "Paste your API key for this provider."}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={keyPrompt?.value ?? ""}
              onChangeText={(v) => setKeyPrompt((cur) => (cur ? { ...cur, value: v } : cur))}
              placeholder="API key"
              placeholderTextColor={t.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setKeyPrompt(null)} style={styles.modalBtn} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (!keyPrompt) return;
                  const { entry, value } = keyPrompt;
                  setKeyPrompt(null);
                  void doInstall(entry, value);
                }}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                accessibilityRole="button"
                accessibilityLabel="Add provider"
              >
                <Text style={styles.modalBtnPrimaryText}>Add</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function CategoryChip({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} hitSlop={4}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    loadingBox: { paddingVertical: 48, alignItems: "center" },
    body: { flex: 1 },
    bodyContent: { padding: 18, gap: 20 },
    section: { gap: 8 },
    sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textTertiary, marginBottom: 2 },
    chipRow: { gap: 6, paddingVertical: 2, paddingRight: 4 },
    chip: {
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 5,
      backgroundColor: t.surface2,
    },
    chipActive: { borderColor: t.accent, backgroundColor: t.accentDim },
    chipText: { ...typeScale.caption, color: t.textSecondary },
    chipTextActive: { color: t.textPrimary },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...typeScale.control, color: t.textPrimary },
    rowSub: { ...typeScale.caption, color: t.textSecondary },
    rowUrl: { ...typeScale.micro, color: t.textTertiary, marginTop: 1 },
    iconBtn: { padding: 4 },
    linkRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
    linkText: { ...typeScale.micro, color: t.textTertiary },
    addBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: t.accent,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 8,
    },
    addBtnOutline: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.accent },
    addBtnText: { ...typeScale.label, color: t.accentFg },
    addBtnTextOutline: { color: t.accent },
    installedTag: { flexDirection: "row", alignItems: "center", gap: 4 },
    installedText: { ...typeScale.label, color: t.success },
    errorText: { ...typeScale.caption, color: t.danger },
    footer: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 4 },
    footerText: { ...typeScale.micro, color: t.textTertiary, flex: 1 },
    modalBackdrop: { flex: 1, backgroundColor: t.scrim, alignItems: "center", justifyContent: "center", padding: 24 },
    modalCard: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 14,
      padding: 18,
      gap: 10,
    },
    modalTitle: { ...typeScale.subtitle, color: t.textPrimary },
    modalMessage: { ...typeScale.caption, color: t.textSecondary },
    modalInput: {
      ...typeScale.body,
      color: t.textPrimary,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
    modalBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
    modalBtnText: { ...typeScale.label, color: t.textSecondary },
    modalBtnPrimary: { backgroundColor: t.accent },
    modalBtnPrimaryText: { ...typeScale.label, color: t.accentFg },
  });
}
