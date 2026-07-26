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
  Platform,
  Modal,
  TextInput,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { RefreshCw, Plus, Trash2, ExternalLink, Wrench, ChevronRight, ChevronDown, LogIn, LogOut } from "lucide-react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { haptics, toolbarPress } from "@/haptics";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { fetchManifest, getCachedManifest } from "@/chat/registry";
import {
  listInstalledServices,
  installService,
  uninstallService,
  serviceOperationDefs,
  type InstalledService,
} from "@/chat/services";
import {
  listInstalledMcpServers,
  installMcpServer,
  uninstallMcpServer,
  refreshServerTools,
  getCachedMcpToolDefsForServer,
  type InstalledMcpServer,
} from "@/chat/mcp-store";
import { startAuth, signOut, hasTokens, type OAuthServerConfig } from "@/chat/mcp-oauth";
import { TOOLS, WRITE_TOOL_NAMES, type ToolDef } from "@/chat/tools";
import { getToggleMap, setToolEnabled } from "@/chat/tool-toggles";
import type { RegistryServiceEntry, RegistryMcpEntry } from "@cairn/shared/chat/registry-schema";
import { ConnectorLogo } from "@/components/ConnectorLogo";
import { SearchField } from "@/components/SearchField";

/**
 * Does a browsable registry entry match the search query? Mirrors desktop's
 * BrowseCommunityModal filter: name + blurb + category + tags (tags feed search
 * only, never shown as chips). `q` must already be lowercased + trimmed.
 */
function entryMatchesQuery(
  entry: { blurb: string; category?: string; tags: string[]; definition: { name: string } },
  q: string,
): boolean {
  if (!q) return true;
  return (
    entry.definition.name.toLowerCase().includes(q) ||
    entry.blurb.toLowerCase().includes(q) ||
    (entry.category ?? "").toLowerCase().includes(q) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

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
 *   3. Browse community    — a search box + category chips (mirroring desktop's
 *      Browse Community modal) that filter both the installable services and MCP
 *      servers below. Freeform tags feed search only; the chips are the fixed
 *      category vocabulary and shrink as you install things.
 *   4. Add a service        — the catalog of installable services (authMode:none
 *      only for now; OAuth services are shown but not yet installable).
 *   5. Add an MCP server     — installable MCP servers (OAuth via deep-link).
 */

// Split the always-on built-in tools into Read vs Write for the disclosure.
const READ_BUILTINS: ToolDef[] = TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name));
const WRITE_BUILTINS: ToolDef[] = TOOLS.filter((t) => WRITE_TOOL_NAMES.has(t.name));

/** Map an installed OAuth MCP server to the OAuth flow's server config. */
function oauthCfg(s: InstalledMcpServer): OAuthServerConfig {
  return { id: s.id, serverUrl: s.baseUrl, scope: s.oauthScope };
}

export default function ToolsSettingsScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();

  const [installed, setInstalled] = useState<InstalledService[]>(() => listInstalledServices());
  const [installedMcp, setInstalledMcp] = useState<InstalledMcpServer[]>(() => listInstalledMcpServers());
  const [services, setServices] = useState<RegistryServiceEntry[]>(() => getCachedManifest()?.services ?? []);
  const [mcpEntries, setMcpEntries] = useState<RegistryMcpEntry[]>(() => getCachedManifest()?.mcpServers ?? []);
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => getToggleMap());
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Start un-blocked when we already have a cached catalog: render it instantly
  // and let loadRegistry refresh in the background. Only show the full-screen
  // spinner on a cold start (nothing cached yet).
  const [loading, setLoading] = useState(() => getCachedManifest() === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Built-in tools are collapsed by default so the screen stays compact — the
  // list is long and informational, not something you act on often.
  const [builtinsOpen, setBuiltinsOpen] = useState(false);
  // Which installed MCP server's tool list is expanded (one at a time).
  const [expandedMcp, setExpandedMcp] = useState<string | null>(null);
  // Which installed multi-op service's tool list is expanded (one at a time).
  const [expandedService, setExpandedService] = useState<string | null>(null);
  // Browse filters (services + MCP catalog) — mirror desktop's search + category
  // chips. Freeform tags feed search only; the chips are the fixed category set.
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseCategory, setBrowseCategory] = useState<string | null>(null);
  // Android has no Alert.prompt, so key-based installs use an in-app modal. iOS
  // keeps the native prompt. `keyPrompt` holds the entry being keyed + the typed
  // value; null when closed.
  const [keyPrompt, setKeyPrompt] = useState<{ entry: RegistryServiceEntry; value: string } | null>(null);

  const reloadLocal = useCallback(() => {
    setInstalled(listInstalledServices());
    setInstalledMcp(listInstalledMcpServers());
    setToggles(getToggleMap());
  }, []);

  // Refresh the per-OAuth-server connected (has-tokens) map for the badges.
  const refreshConnected = useCallback(async () => {
    const servers = listInstalledMcpServers().filter((s) => s.authMode === "oauth");
    const entries = await Promise.all(servers.map(async (s) => [s.id, await hasTokens(s.id)] as const));
    setConnected(Object.fromEntries(entries));
  }, []);

  const loadRegistry = useCallback(
    async (force: boolean) => {
      const { manifest, error: err } = await fetchManifest(force);
      setServices(manifest?.services ?? []);
      setMcpEntries(manifest?.mcpServers ?? []);
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
    void refreshConnected();
    return () => {
      cancelled = true;
    };
  }, [loadRegistry, refreshConnected]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    haptics.selection();
    void loadRegistry(true).finally(() => setRefreshing(false));
  }, [loadRegistry]);

  const onToggleService = useCallback((name: string, next: boolean) => {
    haptics.selection();
    setToolEnabled(name, next);
    setToggles(getToggleMap());
  }, []);

  // ── MCP servers ─────────────────────────────────────────────────────────────

  /** Sign in to an OAuth MCP server (deep-link browser flow), then cache tools. */
  const onConnect = useCallback(
    async (s: InstalledMcpServer) => {
      setBusyId(s.id);
      try {
        const res = await startAuth(oauthCfg(s), s.name);
        if (res.status === "error") {
          Alert.alert(res.desktopOnly ? "Connect on desktop" : "Sign-in failed", res.error);
        } else if (res.status === "authorized") {
          haptics.success();
          await refreshServerTools(s.id).catch(() => null);
        }
        // "cancelled" → no-op.
      } finally {
        setBusyId(null);
        await refreshConnected();
      }
    },
    [refreshConnected],
  );

  const onSignOut = useCallback(
    (s: InstalledMcpServer) => {
      Alert.alert(`Sign out of ${s.name}?`, "Cairn will forget this server's tokens on this device.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            await signOut(s.id);
            haptics.success();
            await refreshConnected();
          },
        },
      ]);
    },
    [refreshConnected],
  );

  /** Install an MCP server from the registry; auto-start OAuth for oauth servers. */
  const onInstallMcp = useCallback(
    async (entry: RegistryMcpEntry) => {
      if (entry.definition.transport !== "http") {
        Alert.alert("Not supported", "Only streamable-HTTP MCP servers work on mobile right now.");
        return;
      }
      installMcpServer(entry);
      reloadLocal();
      const server = listInstalledMcpServers().find((s) => s.id === entry.id);
      if (server && server.authMode === "oauth") {
        await onConnect(server);
      } else if (server) {
        // No-auth (or API-key header) server: discover tools immediately.
        setBusyId(server.id);
        try {
          await refreshServerTools(server.id).catch(() => null);
        } finally {
          setBusyId(null);
        }
      }
    },
    [reloadLocal, onConnect],
  );

  const onUninstallMcp = useCallback(
    (s: InstalledMcpServer) => {
      Alert.alert(`Remove ${s.name}?`, "This disconnects the server and forgets its tokens on this device.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await uninstallMcpServer(s.id);
            haptics.success();
            reloadLocal();
            await refreshConnected();
          },
        },
      ]);
    },
    [reloadLocal, refreshConnected],
  );

  /** Manually re-discover a server's tools (refresh the cached list). */
  const onRefreshServer = useCallback(async (id: string) => {
    setBusyId(`refresh:${id}`);
    try {
      await refreshServerTools(id).catch(() => null);
      // Nudge a re-render so the freshly-cached tools appear.
      setToggles(getToggleMap());
    } finally {
      setBusyId(null);
    }
  }, []);

  // Perform the install with a (possibly empty) API key, surfacing failures.
  const installWithKey = useCallback(
    async (entry: RegistryServiceEntry, apiKey: string) => {
      const res = await installService(entry, apiKey);
      if (!res.ok) {
        Alert.alert("Couldn't install", res.error ?? "Unknown error.");
        return;
      }
      haptics.success();
      reloadLocal();
    },
    [reloadLocal],
  );

  const onInstall = useCallback(
    (entry: RegistryServiceEntry) => {
      if (entry.definition.authMode === "oauth") {
        Alert.alert("Not yet supported", "OAuth services can't be installed on mobile yet — coming soon.");
        return;
      }
      const needsKey = JSON.stringify(entry.definition.headers ?? {}).includes("<API_KEY>");
      if (!needsKey) {
        void installWithKey(entry, "");
        return;
      }
      const message = entry.definition.apiKeyUrl
        ? `Paste your API key. Get one at ${entry.definition.apiKeyUrl}.`
        : "Paste your API key for this service.";
      // Alert.prompt is iOS-only; Android falls back to an in-app modal.
      if (Platform.OS === "ios") {
        Alert.prompt(
          `Add ${entry.definition.name}`,
          message,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Install", onPress: (v?: string) => void installWithKey(entry, v ?? "") },
          ],
          "plain-text",
        );
      } else {
        setKeyPrompt({ entry, value: "" });
      }
    },
    [installWithKey],
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

  // Registry entries not already installed (installed ones move to section 1),
  // then narrowed by the search query + category chip. Membership is tested
  // against Sets built from the in-state installed lists — NOT isServiceInstalled
  // / isMcpServerInstalled, which each re-read + JSON.parse the whole installed
  // list from SQLite per element (O(catalog × parse) on every recompute).
  const installedServiceIds = useMemo(() => new Set(installed.map((s) => s.id)), [installed]);
  const installedMcpIds = useMemo(() => new Set(installedMcp.map((s) => s.id)), [installedMcp]);
  // Precompute the per-row tool defs once per installed-list change, so unrelated
  // re-renders (busyId / connected / expand toggles) don't rebuild service
  // operation defs or re-read + JSON.parse the MCP tool cache for every row.
  const serviceOpsById = useMemo(
    () => new Map(installed.map((svc) => [svc.id, serviceOperationDefs(svc)])),
    [installed],
  );
  const mcpToolsById = useMemo(
    () => new Map(installedMcp.map((s) => [s.id, getCachedMcpToolDefsForServer(s.id)])),
    [installedMcp],
  );
  const notInstalledServices = useMemo(
    () => services.filter((s) => !installedServiceIds.has(s.id)),
    [services, installedServiceIds],
  );
  const notInstalledMcp = useMemo(
    () => mcpEntries.filter((s) => !installedMcpIds.has(s.id)),
    [mcpEntries, installedMcpIds],
  );

  // Category chips are the union of categories present across everything still
  // installable (services + MCP), so the chip set shrinks as you install things.
  const browseCategories = useMemo(() => {
    const set = new Set<string>();
    for (const e of [...notInstalledServices, ...notInstalledMcp]) {
      if (e.category) set.add(e.category);
    }
    return [...set].sort();
  }, [notInstalledServices, notInstalledMcp]);

  const q = browseQuery.trim().toLowerCase();
  const browsable = useMemo(
    () =>
      notInstalledServices.filter(
        (s) => (!browseCategory || s.category === browseCategory) && entryMatchesQuery(s, q),
      ),
    [notInstalledServices, browseCategory, q],
  );
  const browsableMcp = useMemo(
    () =>
      notInstalledMcp.filter(
        (s) => (!browseCategory || s.category === browseCategory) && entryMatchesQuery(s, q),
      ),
    [notInstalledMcp, browseCategory, q],
  );
  // Are there any installable entries at all (before search/category narrowing)?
  const hasAnyBrowsable = notInstalledServices.length > 0 || notInstalledMcp.length > 0;

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
          {/* 1. Installed services — expandable per-operation tool toggles */}
          {installed.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Installed services</Text>
              {installed.map((svc) => {
                const ops = serviceOpsById.get(svc.id) ?? [];
                const open = expandedService === svc.id;
                // A single-operation service shows its lone toggle inline; a
                // multi-operation one gets an expandable tool list like MCP.
                const multi = ops.length > 1;
                return (
                  <View key={svc.id} style={styles.mcpCard}>
                    <View style={styles.mcpHeader}>
                      <ConnectorLogo iconSvg={svc.iconSvg} kind="service" color={svc.brandColor} size={22} />
                      <View style={styles.rowMain}>
                        <Text style={styles.rowTitle}>{svc.name}</Text>
                        {!!svc.blurb && <Text style={styles.rowSub} numberOfLines={2}>{svc.blurb}</Text>}
                      </View>
                      {!multi && ops[0] && (
                        <Switch
                          value={toggles[ops[0].name] !== false}
                          onValueChange={(v) => onToggleService(ops[0].name, v)}
                          trackColor={{ true: t.accent, false: t.border }}
                        />
                      )}
                      <Pressable
                        onPress={() => onUninstall(svc)}
                        hitSlop={8}
                        style={styles.iconBtn}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${svc.name}`}
                      >
                        <Trash2 size={18} color={t.danger} />
                      </Pressable>
                    </View>

                    {multi && (
                      <>
                        <Pressable
                          style={styles.mcpToolsToggle}
                          onPress={() => {
                            haptics.selection();
                            setExpandedService((cur) => (cur === svc.id ? null : svc.id));
                          }}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`${open ? "Collapse" : "Expand"} ${svc.name} tools`}
                        >
                          {open ? (
                            <ChevronDown size={14} color={t.textSecondary} />
                          ) : (
                            <ChevronRight size={14} color={t.textSecondary} />
                          )}
                          <Text style={styles.mcpToolsLabel}>{ops.length} tools</Text>
                        </Pressable>
                        {open &&
                          ops.map((op) => {
                            const short = op.name.split("__").slice(2).join("__") || op.name;
                            return (
                              <View key={op.name} style={styles.mcpToolRow}>
                                <View style={styles.rowMain}>
                                  <Text style={styles.mcpToolName}>{short}</Text>
                                  {!!op.description && (
                                    <Text style={styles.builtinDesc} numberOfLines={2}>{op.description}</Text>
                                  )}
                                </View>
                                <Switch
                                  value={toggles[op.name] !== false}
                                  onValueChange={(v) => onToggleService(op.name, v)}
                                  trackColor={{ true: t.accent, false: t.border }}
                                />
                              </View>
                            );
                          })}
                      </>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {/* 1b. Installed MCP servers (connect/sign-out for OAuth; uninstall) */}
          {installedMcp.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>MCP servers</Text>
              {installedMcp.map((s) => {
                const isOAuth = s.authMode === "oauth";
                const isConnected = connected[s.id] === true;
                const busy = busyId === s.id;
                const tools = mcpToolsById.get(s.id) ?? [];
                const open = expandedMcp === s.id;
                return (
                  <View key={s.id} style={styles.mcpCard}>
                    <View style={styles.mcpHeader}>
                      <ConnectorLogo iconSvg={s.iconSvg} kind="mcp" color={s.brandColor} size={22} />
                      <View style={styles.rowMain}>
                        <Text style={styles.rowTitle}>{s.name}</Text>
                        {!!s.blurb && <Text style={styles.rowSub} numberOfLines={2}>{s.blurb}</Text>}
                        {isOAuth && (
                          <Text style={[styles.statusText, { color: isConnected ? t.success : t.textTertiary }]}>
                            {isConnected ? "Connected" : "Not connected"}
                          </Text>
                        )}
                      </View>
                      {busy ? (
                        <ActivityIndicator color={t.accent} />
                      ) : isOAuth ? (
                        <Pressable
                          onPress={() => (isConnected ? onSignOut(s) : void onConnect(s))}
                          style={styles.iconBtn}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={isConnected ? `Sign out of ${s.name}` : `Connect to ${s.name}`}
                        >
                          {isConnected ? (
                            <LogOut size={18} color={t.textSecondary} />
                          ) : (
                            <LogIn size={18} color={t.accent} />
                          )}
                        </Pressable>
                      ) : null}
                      <Pressable
                        onPress={() => onUninstallMcp(s)}
                        hitSlop={8}
                        style={styles.iconBtn}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${s.name}`}
                      >
                        <Trash2 size={18} color={t.danger} />
                      </Pressable>
                    </View>

                    {/* Per-server tool manager: expand to toggle individual tools. */}
                    <View style={styles.mcpToolsBar}>
                      <Pressable
                        style={styles.mcpToolsToggle}
                        onPress={() => {
                          haptics.selection();
                          setExpandedMcp((cur) => (cur === s.id ? null : s.id));
                        }}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${s.name} tools`}
                      >
                        {open ? (
                          <ChevronDown size={14} color={t.textSecondary} />
                        ) : (
                          <ChevronRight size={14} color={t.textSecondary} />
                        )}
                        <Text style={styles.mcpToolsLabel}>
                          {tools.length === 0 ? "No tools discovered yet" : `${tools.length} tools`}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void onRefreshServer(s.id)}
                        hitSlop={8}
                        disabled={busyId === `refresh:${s.id}`}
                        style={styles.iconBtn}
                        accessibilityRole="button"
                        accessibilityLabel={`Refresh ${s.name} tools`}
                      >
                        {busyId === `refresh:${s.id}` ? (
                          <ActivityIndicator color={t.textSecondary} size="small" />
                        ) : (
                          <RefreshCw size={14} color={t.textSecondary} />
                        )}
                      </Pressable>
                    </View>

                    {open &&
                      tools.map((def) => {
                        const name = def.function.name;
                        // Show the un-namespaced tool name (after mcp__<id>__).
                        const short = name.split("__").slice(2).join("__") || name;
                        return (
                          <View key={name} style={styles.mcpToolRow}>
                            <View style={styles.rowMain}>
                              <Text style={styles.mcpToolName}>{short}</Text>
                              {!!def.function.description && (
                                <Text style={styles.builtinDesc} numberOfLines={2}>
                                  {def.function.description}
                                </Text>
                              )}
                            </View>
                            <Switch
                              value={toggles[name] !== false}
                              onValueChange={(v) => onToggleService(name, v)}
                              trackColor={{ true: t.accent, false: t.border }}
                            />
                          </View>
                        );
                      })}
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
              accessibilityRole="button"
              accessibilityLabel={`${builtinsOpen ? "Collapse" : "Expand"} built-in tools`}
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

          {/* 3. Browse filters — search + category chips (govern both Add lists) */}
          {hasAnyBrowsable && (
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionLabel}>Browse community</Text>
                <Pressable
                  onPress={onRefresh}
                  hitSlop={8}
                  disabled={refreshing}
                  style={styles.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh community catalog"
                >
                  <RefreshCw size={16} color={refreshing ? t.textTertiary : t.textSecondary} />
                </Pressable>
              </View>
              <SearchField
                value={browseQuery}
                onChangeText={setBrowseQuery}
                placeholder="Search connectors and services…"
              />
              {browseCategories.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  <CategoryChip
                    label="All"
                    active={browseCategory === null}
                    onPress={() => {
                      haptics.selection();
                      setBrowseCategory(null);
                    }}
                    styles={styles}
                  />
                  {browseCategories.map((cat) => (
                    <CategoryChip
                      key={cat}
                      label={cat}
                      active={browseCategory === cat}
                      onPress={() => {
                        haptics.selection();
                        setBrowseCategory((cur) => (cur === cat ? null : cat));
                      }}
                      styles={styles}
                    />
                  ))}
                </ScrollView>
              )}
            </View>
          )}

          {/* 3b. Add a service */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Services</Text>
            {error && <Text style={styles.errorText}>{error}</Text>}
            {browsable.length === 0 && !error ? (
              <Text style={styles.sectionHint}>
                {!hasAnyBrowsable
                  ? "Nothing new to add — you've installed everything available."
                  : "No services match your search."}
              </Text>
            ) : (
              browsable.map((entry) => {
                const oauth = entry.definition.authMode === "oauth";
                return (
                  <View key={entry.id} style={styles.row}>
                    <ConnectorLogo iconSvg={entry.iconSvg} kind="service" color={entry.brandColor} size={22} />
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

          {/* 4. Add an MCP server (OAuth supported via deep-link sign-in) */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>MCP servers</Text>
            {browsableMcp.length === 0 ? (
              <Text style={styles.sectionHint}>
                {notInstalledMcp.length === 0
                  ? "No new MCP servers to add."
                  : "No MCP servers match your search."}
              </Text>
            ) : (
              <>
                <Text style={styles.sectionHint}>
                  Some providers only allow sign-in from a desktop browser and will reject the
                  mobile connection — connect those in the desktop app instead.
                </Text>
                {browsableMcp.map((entry) => {
                 const httpOk = entry.definition.transport === "http";
                 const oauth = entry.definition.authMode === "oauth";
                return (
                  <View key={entry.id} style={styles.row}>
                    <ConnectorLogo iconSvg={entry.iconSvg} kind="mcp" color={entry.brandColor} size={22} />
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle}>{entry.definition.name}</Text>
                      <Text style={styles.rowSub} numberOfLines={2}>{entry.blurb}</Text>
                      {!httpOk && <Text style={styles.statusText}>SSE transport not supported on mobile</Text>}
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
                      onPress={() => void onInstallMcp(entry)}
                      disabled={!httpOk || busyId === entry.id}
                      style={[styles.addBtn, !httpOk && styles.addBtnDisabled]}
                      hitSlop={6}
                    >
                      {busyId === entry.id ? (
                        <ActivityIndicator color={t.accentFg} />
                      ) : (
                        <>
                          <Plus size={14} color={httpOk ? t.accentFg : t.textTertiary} />
                          <Text style={[styles.addBtnText, !httpOk && styles.addBtnTextDisabled]}>
                            {oauth ? "Connect" : "Add"}
                          </Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                );
                })}
              </>
            )}
          </View>

          <View style={styles.footer}>
            <Wrench size={12} color={t.textTertiary} />
            <Text style={styles.footerText}>
              Services, servers, and toggles are stored on this device only and never sync.
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
            <Text style={styles.modalTitle}>
              Add {keyPrompt?.entry.definition.name}
            </Text>
            <Text style={styles.modalMessage}>
              {keyPrompt?.entry.definition.apiKeyUrl
                ? `Paste your API key. Get one at ${keyPrompt.entry.definition.apiKeyUrl}.`
                : "Paste your API key for this service."}
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
              <Pressable
                onPress={() => setKeyPrompt(null)}
                style={styles.modalBtn}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (!keyPrompt) return;
                  const { entry, value } = keyPrompt;
                  setKeyPrompt(null);
                  void installWithKey(entry, value);
                }}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                accessibilityRole="button"
                accessibilityLabel="Install service"
              >
                <Text style={styles.modalBtnPrimaryText}>Install</Text>
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
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      hitSlop={4}
    >
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
    chipActive: {
      borderColor: t.accent,
      backgroundColor: t.accentDim,
    },
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
    statusText: { ...typeScale.micro, color: t.textTertiary, marginTop: 2 },
    // MCP server card: header + collapsible per-tool manager.
    mcpCard: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      gap: 8,
    },
    mcpHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
    mcpToolsBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: 1,
      borderTopColor: t.border,
      paddingTop: 8,
    },
    mcpToolsToggle: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
    mcpToolsLabel: { ...typeScale.micro, color: t.textSecondary },
    mcpToolRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    mcpToolName: { ...typeScale.label, color: t.textPrimary },
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
    builtinGroup: { gap: 6, marginTop: 4 },
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
    modalBackdrop: {
      flex: 1,
      backgroundColor: t.scrim,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
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
