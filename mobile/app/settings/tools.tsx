import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Switch,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Linking,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { RefreshCw, Plus, Trash2, ExternalLink, Wrench, ChevronRight, ChevronDown } from "lucide-react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { haptics, toolbarPress } from "@/haptics";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { fetchManifest, getCachedManifest } from "@/chat/registry";
import {
  listInstalledServices,
  installService,
  uninstallService,
  isServiceInstalled,
  type InstalledService,
} from "@/chat/services";
import { TOOLS, WRITE_TOOL_NAMES, type ToolDef } from "@/chat/tools";
import { getToggleMap, setToolEnabled } from "@/chat/tool-toggles";
import { namespaceServiceTool, parseToolDefinition } from "@cairn/shared/chat/service-exec";
import type { RegistryServiceEntry } from "@cairn/shared/chat/registry-schema";

/**
 * Tools & Services settings — the mobile side of the community registry (Track
 * 2). All DEVICE-GLOBAL (they apply across every workspace) and unsynced:
 *
 *   1. Installed services  — HTTP `service` connectors the user has added, each
 *      with an on/off toggle + uninstall. Their API keys live in the keychain.
 *      These are the ONLY toggleable tools — matching desktop, which gates only
 *      external MCP/HTTP tools, never Cairn's own.
 *   2. Built-in tools       — a READ-ONLY, collapsed-by-default disclosure that
 *      shows what the assistant can do, split into Read vs Write. No switches:
 *      built-ins are always on (turning off e.g. search would silently break the
 *      assistant), so this is purely informational.
 *   3. Add a service        — the catalog of installable services (authMode:none
 *      only for now; OAuth services are shown but not yet installable).
 */

// Split the always-on built-in tools into Read vs Write for the disclosure.
const READ_BUILTINS: ToolDef[] = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name));
const WRITE_BUILTINS: ToolDef[] = TOOLS.filter((t) => WRITE_TOOL_NAMES.has(t.name));

export default function ToolsSettingsScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();

  const [installed, setInstalled] = useState<InstalledService[]>(() => listInstalledServices());
  const [services, setServices] = useState<RegistryServiceEntry[]>(() => getCachedManifest()?.services ?? []);
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => getToggleMap());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Built-in tools are collapsed by default so the screen stays compact — the
  // list is long and informational, not something you act on often.
  const [builtinsOpen, setBuiltinsOpen] = useState(false);

  const reloadLocal = useCallback(() => {
    setInstalled(listInstalledServices());
    setToggles(getToggleMap());
  }, []);

  const loadRegistry = useCallback(
    async (force: boolean) => {
      const { manifest, error: err } = await fetchManifest(force);
      setServices(manifest?.services ?? []);
      setError(err ?? null);
    },
    [],
  );

  useEffect(() => {
    // Local + cached state is seeded via lazy useState initializers above. The
    // network refresh's setState all happens AFTER an await inside loadRegistry
    // (and in this .finally callback), so nothing runs synchronously in the
    // effect body.
    let cancelled = false;
    // setState here only runs inside the async .finally callback (after an await
    // boundary the rule's static trace can't follow), never synchronously in the
    // effect body — the idiomatic on-mount fetch used across the app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRegistry(false).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRegistry]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    haptics.selection();
    void loadRegistry(true).finally(() => setRefreshing(false));
  }, [loadRegistry]);

  const serviceToolName = useCallback((svc: InstalledService): string => {
    try {
      return namespaceServiceTool(svc.id, parseToolDefinition(svc.definition.toolDefinition).name);
    } catch {
      return svc.id;
    }
  }, []);

  const onToggleService = useCallback((name: string, next: boolean) => {
    haptics.selection();
    setToolEnabled(name, next);
    setToggles(getToggleMap());
  }, []);

  const onInstall = useCallback(
    (entry: RegistryServiceEntry) => {
      if (entry.definition.authMode === "oauth") {
        Alert.alert("Not yet supported", "OAuth services can't be installed on mobile yet — coming soon.");
        return;
      }
      const needsKey = JSON.stringify(entry.definition.headers ?? {}).includes("<API_KEY>");
      const finish = async (apiKey: string) => {
        const res = await installService(entry, apiKey);
        if (!res.ok) {
          Alert.alert("Couldn't install", res.error ?? "Unknown error.");
          return;
        }
        haptics.success();
        reloadLocal();
      };
      if (!needsKey) {
        void finish("");
        return;
      }
      Alert.prompt(
        `Add ${entry.definition.name}`,
        entry.definition.apiKeyUrl
          ? `Paste your API key. Get one at ${entry.definition.apiKeyUrl}.`
          : "Paste your API key for this service.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Install", onPress: (v?: string) => void finish(v ?? "") },
        ],
        "plain-text",
      );
    },
    [reloadLocal],
  );

  const onUninstall = useCallback(
    (svc: InstalledService) => {
      Alert.alert(`Remove ${svc.name}?`, "Its API key will be deleted from this device.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await uninstallService(svc.id);
            haptics.success();
            reloadLocal();
          },
        },
      ]);
    },
    [reloadLocal],
  );

  // Registry entries not already installed (installed ones move to section 1).
  const browsable = useMemo(
    () => services.filter((s) => !isServiceInstalled(s.id)),
    [services, installed], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const renderBuiltinGroup = (label: string, tools: ToolDef[]) => (
    <View style={styles.builtinGroup}>
      <Text style={styles.builtinGroupLabel}>{label}</Text>
      {tools.map((tool) => (
        <View key={tool.name} style={styles.builtinRow}>
          <Text style={styles.builtinName}>{tool.name}</Text>
          <Text style={styles.builtinDesc} numberOfLines={2}>{tool.description}</Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: "Tools & Services" }} />
      <Stack.Toolbar>
        <Stack.Toolbar.Button
          icon={ICON_CHECK}
          accessibilityLabel="Done"
          onPress={() => toolbarPress(() => router.canGoBack() && router.back())()}
        />
      </Stack.Toolbar>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {/* 1. Installed services (the only toggleable tools) */}
          {installed.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Installed services</Text>
              {installed.map((svc) => {
                const name = serviceToolName(svc);
                return (
                  <View key={svc.id} style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle}>{svc.name}</Text>
                      {!!svc.blurb && <Text style={styles.rowSub} numberOfLines={2}>{svc.blurb}</Text>}
                    </View>
                    <Switch
                      value={toggles[name] !== false}
                      onValueChange={(v) => onToggleService(name, v)}
                      trackColor={{ true: t.accent, false: t.border }}
                    />
                    <Pressable onPress={() => onUninstall(svc)} hitSlop={8} style={styles.iconBtn}>
                      <Trash2 size={18} color={t.danger} />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}

          {/* 2. Built-in tools — read-only, collapsed-by-default disclosure */}
          <View style={styles.section}>
            <Pressable
              style={styles.disclosureHead}
              onPress={() => {
                haptics.selection();
                setBuiltinsOpen((o) => !o);
              }}
            >
              {builtinsOpen ? (
                <ChevronDown size={16} color={t.textSecondary} />
              ) : (
                <ChevronRight size={16} color={t.textSecondary} />
              )}
              <Text style={styles.disclosureTitle}>Built-in tools</Text>
              <Text style={styles.disclosureCount}>{TOOLS.length}</Text>
            </Pressable>
            {builtinsOpen && (
              <>
                <Text style={styles.sectionHint}>
                  What the assistant can do with your notes and tasks. Always on.
                </Text>
                {renderBuiltinGroup("Read", READ_BUILTINS)}
                {renderBuiltinGroup("Write", WRITE_BUILTINS)}
              </>
            )}
          </View>

          {/* 3. Add a service */}
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionLabel}>Add a service</Text>
              <Pressable onPress={onRefresh} hitSlop={8} disabled={refreshing} style={styles.iconBtn}>
                <RefreshCw size={16} color={refreshing ? t.textTertiary : t.textSecondary} />
              </Pressable>
            </View>
            {error && <Text style={styles.errorText}>{error}</Text>}
            {browsable.length === 0 && !error ? (
              <Text style={styles.sectionHint}>Nothing new to add — you&apos;ve installed everything available.</Text>
            ) : (
              browsable.map((entry) => {
                const oauth = entry.definition.authMode === "oauth";
                return (
                  <View key={entry.id} style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle}>{entry.definition.name}</Text>
                      <Text style={styles.rowSub} numberOfLines={2}>{entry.blurb}</Text>
                      {!!entry.homepage && (
                        <Pressable
                          onPress={() => entry.homepage && Linking.openURL(entry.homepage)}
                          style={styles.linkRow}
                          hitSlop={6}
                        >
                          <ExternalLink size={12} color={t.textTertiary} />
                          <Text style={styles.linkText}>Learn more</Text>
                        </Pressable>
                      )}
                    </View>
                    <Pressable
                      onPress={() => onInstall(entry)}
                      style={[styles.addBtn, oauth && styles.addBtnDisabled]}
                      hitSlop={6}
                    >
                      <Plus size={14} color={oauth ? t.textTertiary : t.accentFg} />
                      <Text style={[styles.addBtnText, oauth && styles.addBtnTextDisabled]}>
                        {oauth ? "OAuth" : "Add"}
                      </Text>
                    </Pressable>
                  </View>
                );
              })
            )}
          </View>

          <View style={styles.footer}>
            <Wrench size={12} color={t.textTertiary} />
            <Text style={styles.footerText}>
              Services and toggles are stored on this device only and never sync.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
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
    addBtnDisabled: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    addBtnText: { ...typeScale.label, color: t.accentFg },
    addBtnTextDisabled: { color: t.textTertiary },
    errorText: { ...typeScale.caption, color: t.danger },
    // Built-in disclosure
    disclosureHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    disclosureTitle: { ...typeScale.overline, color: t.textTertiary },
    disclosureCount: {
      ...typeScale.micro,
      color: t.textTertiary,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 1,
      overflow: "hidden",
    },
    builtinGroup: { gap: 2, marginTop: 4 },
    builtinGroupLabel: { ...typeScale.micro, color: t.textTertiary, marginTop: 4, marginBottom: 2 },
    builtinRow: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 12,
      gap: 1,
    },
    builtinName: { ...typeScale.label, color: t.textPrimary },
    builtinDesc: { ...typeScale.caption, color: t.textSecondary },
    footer: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 4 },
    footerText: { ...typeScale.micro, color: t.textTertiary, flex: 1 },
  });
}
