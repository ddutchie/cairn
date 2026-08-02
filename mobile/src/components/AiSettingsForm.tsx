import { useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { Check, ShieldCheck, RefreshCw, Cpu, Apple, Brain, Wrench, ChevronRight, ChevronDown, Pencil, Wallet, Server, TriangleAlert, Type, Image as ImageIcon, FileText, Video, AudioLines, Star } from "lucide-react-native";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { useTheme } from "@/theme";
import { ProviderLogo } from "@/components/ProviderLogo";
import { formatModelCost, modelInputChips, endpointLogoSlug } from "@cairn/shared/models/model-catalog";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  getOpenAIApiKey,
  getOpenAIBaseUrl,
  getOpenAIModel,
  getOpenAIContextLimit,
  getProviderPref,
  setOpenAIApiKey,
  setOpenAIEndpoint,
  setProviderPref,
  getAppleReasoningLevel,
  setAppleReasoningLevel,
  listSavedProviders,
  getActiveProviderId,
  getProviderApiKey,
  addSavedProvider,
  updateSavedProvider,
  deleteSavedProvider,
  selectSavedProvider,
  readModelsCache,
  writeModelsCache,
  getFavoriteModels,
  toggleFavoriteModel,
  type ProviderPref,
  type SavedProvider,
} from "@/chat/ai-config";
import { isRorkAvailable } from "@/chat/providers/rork";import {
  isAppleProviderAvailable,
  isAppleServerProviderAvailable,
  isAppleDevEnabled,
} from "@/chat/providers/apple";
import {
  appleLlmUnavailableReason,
  appleServerUnavailableReason,
  appleQuotaStatus,
  showAppleQuotaUpgrade,
  type AppleQuotaStatus,
  type AppleReasoningLevel,
} from "@modules/apple-llm";
import { listModels, getKeyInfo, type ProviderKeyInfo } from "@/chat/providers/openai";
import {
  contextLimitForModel,
  getLogoProvider,
  getModelInfo,
  getModelCatalogVersion,
  prewarmModelCatalog,
  subscribeModelCatalog,
} from "@/chat/models-dev";
import { useAiSettingsStyles } from "./ai-settings/styles";
import { SegmentButton } from "./ai-settings/SegmentButton";
import { Field } from "./ai-settings/Field";
import { QuotaBar } from "./ai-settings/QuotaBar";
import { ProviderList, type ResolvedProviderLogo } from "./ai-settings/ProviderList";
import {
  getCachedProvidersManifest,
  fetchProvidersManifest,
} from "@/chat/providers-registry";
import type { ProvidersManifest } from "@cairn/shared/chat/registry-schema";

/** Normalize an endpoint URL for keyed matching (trailing slash + case). */
function normBaseUrl(url: string): string {
  return (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Community brand marks keyed by communityId AND normalized baseUrl. The
 * baseUrl key covers providers added manually that happen to share an
 * endpoint with a catalog entry (e.g. added before it was in the registry).
 */
function buildProviderLogoMap(
  manifest: ProvidersManifest | null,
): Record<string, { iconSvg?: string; brandColor?: string }> {
  const map: Record<string, { iconSvg?: string; brandColor?: string }> = {};
  for (const e of manifest?.providers ?? []) {
    const logo = { iconSvg: e.iconSvg, brandColor: e.brandColor };
    map[e.id] = logo;
    if (e.definition.baseUrl) map[normBaseUrl(e.definition.baseUrl)] = logo;
  }
  return map;
}

/** Format a USD credit amount compactly (e.g. $12.34, $0.0500, $1,234, -$5.00). */
function formatCredits(n: number): string {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? 4 : 2;
  const body = `$${abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
  return n < 0 ? `-${body}` : body;
}

/**
 * AI settings form body. Presented as a native `formSheet` route
 * (`app/settings/ai.tsx`) rather than a hand-rolled modal, so it gets the
 * system modal transition + swipe-to-dismiss instead of a backdrop that slides
 * in with the card. Lets the user pick the chat backend:
 *   - "Apple Intelligence (on-device)" — shown when the device supports it
 *     (iOS 26+, Apple Intelligence enabled). Runs fully offline, no key.
 *   - "Rork" — shown when a Rork endpoint is built into the app.
 *   - "OpenAI-compatible" — always available; the user supplies endpoint + key.
 *
 * The provider segment appears whenever more than one backend is available. The
 * OpenAI fields show only when OpenAI is the selected provider. Non-secret
 * fields (base URL, model) persist to local SQLite; the API key goes to the
 * device keychain (expo-secure-store). Saved on Done.
 */
export function AiSettingsForm({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const styles = useAiSettingsStyles();

  // Warm the models.dev catalog + re-render rows once it arrives (cost/logo/
  // tool markers in the model list).
  useEffect(() => { prewarmModelCatalog(); }, []);
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  // Community-provider brand marks for the saved-provider chips (keyed by
  // communityId). Seeded from the on-device cache so chips render instantly,
  // then refreshed from the network (cache-first) — mirrors the Browse list.
  const [providerLogos, setProviderLogos] = useState<Record<string, { iconSvg?: string; brandColor?: string }>>(() =>
    buildProviderLogoMap(getCachedProvidersManifest()),
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { manifest } = await fetchProvidersManifest();
      if (cancelled || !manifest) return;
      setProviderLogos(buildProviderLogoMap(manifest));
    })();
    return () => { cancelled = true; };
  }, []);
  const router = useRouter();
  const rorkBuiltIn = isRorkAvailable();
  const appleAvailable = isAppleProviderAvailable();
  // Which Apple model backs the "Apple Intelligence" option: PCC (user-facing)
  // or the dev-only on-device model.
  const appleIsServer = isAppleServerProviderAvailable();
  // Availability reason, tailored to which Apple backend is expected: PCC first
  // (user-facing), then the dev on-device model (only when the dev flag is on so
  // no Apple messaging leaks to shipped builds).
  const appleReason = useMemo(() => {
    if (appleAvailable) return "";
    // Prefer the PCC reason; fall back to the on-device reason under the dev flag.
    const server = appleServerUnavailableReason();
    return isAppleDevEnabled() ? appleLlmUnavailableReason() : server;
  }, [appleAvailable]);
  // PCC daily-quota snapshot (only meaningful when PCC is the active Apple model).
  // Seeded from a synchronous native getter via a lazy initializer (like the
  // provider/baseUrl values below) rather than an effect.
  const [quota] = useState<AppleQuotaStatus | null>(() =>
    isAppleServerProviderAvailable() ? appleQuotaStatus() : null,
  );
  // PCC reasoning effort (persisted). Only meaningful when PCC is the active
  // Apple backend; deeper levels trade latency + context for stronger analysis.
  const [reasoning, setReasoning] = useState<AppleReasoningLevel>(() => getAppleReasoningLevel());
  // Whether to show the provider chooser at all: only when there's a choice.
  const showChooser = rorkBuiltIn || appleAvailable;

  // These initial values come from synchronous getters, so seed them via lazy
  // useState initializers (run once) rather than assigning in an effect — the
  // latter is a cascading setState-in-effect the linter flags. The API key is
  // async (secure store), so it's loaded in the effect below.
  const [pref, setPref] = useState<ProviderPref>(() => getProviderPref(rorkBuiltIn));
  const [baseUrl, setBaseUrl] = useState(() => getOpenAIBaseUrl());
  const [model, setModel] = useState(() => getOpenAIModel());
  // Optional manual context-window override (blank = auto via models.dev).
  const [contextLimit, setContextLimit] = useState(() => {
    const v = getOpenAIContextLimit();
    return v ? String(v) : "";
  });
  const [apiKey, setApiKey] = useState("");
  // Whether the selected provider's editable fields are revealed. When false,
  // a read-only summary card is shown instead (tap Edit to reveal inputs).
  const [editing, setEditing] = useState(false);
  // Saved providers + the active one. Loaded (with migration) in an effect since
  // listSavedProviders is async. `name` is the active provider's editable label.
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => getActiveProviderId());
  // Brand mark per saved provider, resolved in priority order: community
  // iconSvg (by communityId, then normalized baseUrl) → models.dev logo slug
  // (for direct-vendor hostnames like api.openai.com that the community
  // catalog has no inline icon for) → none. Recomputed when the list or the
  // community logo map changes.
  const providerLogosResolved = useMemo<Record<string, ResolvedProviderLogo>>(() => {
    const out: Record<string, ResolvedProviderLogo> = {};
    for (const p of providers) {
      const comm = (p.communityId && providerLogos[p.communityId]) || providerLogos[p.baseUrl.toLowerCase().replace(/\/+$/, "")];
      if (comm?.iconSvg) { out[p.id] = { kind: "iconSvg", iconSvg: comm.iconSvg, brandColor: comm.brandColor }; continue; }
      const slug = endpointLogoSlug(p.baseUrl);
      if (slug) out[p.id] = { kind: "slug", slug };
    }
    return out;
  }, [providers, providerLogos]);
  const [name, setName] = useState("");
  // Context window detected from models.dev for the current model (null = not
  // found / not looked up). Shown as a hint when there's no manual override.
  const [detectedContext, setDetectedContext] = useState<number | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [hadKey, setHadKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Model discovery via GET {base}/models.
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Dropdown-style model selector: collapsed trigger shows the current model;
  // expanding reveals the searchable list. `customModel` swaps in a free-text
  // input for ids the endpoint didn't list (gateway/proxy names).
  const [modelOpen, setModelOpen] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  // Free-text filter over the fetched model ids (providers can return 50+).
  const [modelQuery, setModelQuery] = useState("");
  // Starred models (global, persisted via the meta DB like desktop's
  // localStorage list). Only used by the dropdown rows.
  const [favorites, setFavorites] = useState<Set<string>>(() => getFavoriteModels());
  const toggleFavorite = useCallback((id: string) => {
    haptics.selection();
    setFavorites(toggleFavoriteModel(id));
  }, []);
  // Remaining credits for providers that expose it (e.g. OpenRouter). null =
  // not supported / unknown, so the display is hidden.
  const [keyInfo, setKeyInfo] = useState<ProviderKeyInfo | null>(null);
  // Advances whenever a credits lookup starts or keyInfo is cleared, so a slow
  // older getKeyInfo response can't overwrite current or freshly-cleared state
  // (e.g. after switching to a provider that exposes no credits).
  const keyInfoGenRef = useRef(0);

  // Load saved providers (runs the flat→list migration) + the active provider's
  // key on mount. The active provider's baseUrl/model are already reflected by
  // the synchronous getters seeded above; here we sync the name + full list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listSavedProviders();
        if (cancelled) return;
        setProviders(list);
        const active = list.find((p) => p.id === getActiveProviderId()) ?? list[0] ?? null;
        setActiveId(active?.id ?? null);
        setName(active?.name ?? "");
        if (active) {
          setBaseUrl(active.baseUrl);
          setModel(active.model);
          setContextLimit(active.contextLimit ? String(active.contextLimit) : "");
        }
        const openai = active ? await getProviderApiKey(active.id) : await getOpenAIApiKey();
        if (cancelled) return;
        setHadKey(openai != null);
        setApiKey(openai ?? "");
        setLoadedKey(openai ?? "");
      } catch {
        // Best-effort — a failed load leaves the (default) seeded fields in place
        // rather than hanging on the spinner forever.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the provider LIST when the form regains focus (e.g. after adding a
  // provider on the Browse Providers screen), so a newly-installed community
  // provider appears in the switcher. We only sync the list — not the active
  // provider's editable fields — so any in-progress edits here aren't clobbered.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const list = await listSavedProviders();
        if (!cancelled) setProviders(list);
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );
  // Switch the active provider: persist any pending edits to the current one,
  // then load the target provider's values into the fields. Guarded against
  // concurrent invocations so a rapid tap-tap can't persist edits to the wrong
  // provider (the outgoing setOpenAI* writes race with the next switch's reads).
  const providerOpInFlight = useRef(false);
  const switchProvider = async (id: string) => {
    if (id === activeId || providerOpInFlight.current) return;
    providerOpInFlight.current = true;
    try {
      // Persist current edits to the (still) active provider before switching.
      if (activeId) {
        setOpenAIEndpoint(baseUrl, model, contextLimit.trim() ? parseInt(contextLimit, 10) : undefined);
        if (apiKey !== loadedKey) await setOpenAIApiKey(apiKey);
      }
      selectSavedProvider(id);
      setActiveId(id);
      // Re-read the list so we load the just-persisted values, not a stale copy.
      const list = await listSavedProviders();
      setProviders(list);
      const target = list.find((p) => p.id === id);
      if (target) {
        setName(target.name);
        setBaseUrl(target.baseUrl);
        setModel(target.model);
        setContextLimit(target.contextLimit ? String(target.contextLimit) : "");
      }
      const key = await getProviderApiKey(id);
      setApiKey(key ?? "");
      setLoadedKey(key ?? "");
      setHadKey(key != null);
      setModels([]);
      setModelsError(null);
      setModelQuery("");
      keyInfoGenRef.current += 1; // invalidate any in-flight credits lookup
      setKeyInfo(null);
      setEditing(false); // show the newly-selected provider's summary first
      haptics.selection();
    } finally {
      providerOpInFlight.current = false;
    }
  };

  // Add a new blank provider: persist current edits, create the provider, make
  // it active, and reset the fields to defaults for editing. Shares the in-flight
  // guard with switchProvider so the two can't interleave.
  const addProvider = async () => {
    if (providerOpInFlight.current) return;
    providerOpInFlight.current = true;
    try {
      if (activeId) {
        setOpenAIEndpoint(baseUrl, model, contextLimit.trim() ? parseInt(contextLimit, 10) : undefined);
        if (apiKey !== loadedKey) await setOpenAIApiKey(apiKey);
      }
      const count = providers.length + 1;
      const id = await addSavedProvider({
        name: `Provider ${count}`,
        baseUrl: DEFAULT_OPENAI_BASE_URL,
        model: DEFAULT_OPENAI_MODEL,
      });
      const list = await listSavedProviders();
      setProviders(list);
      setActiveId(id);
      setName(`Provider ${count}`);
      setBaseUrl(DEFAULT_OPENAI_BASE_URL);
      setModel(DEFAULT_OPENAI_MODEL);
      setContextLimit("");
      setApiKey("");
      setLoadedKey("");
      setHadKey(false);
      setModels([]);
      setModelsError(null);
      setModelQuery("");
      keyInfoGenRef.current += 1; // invalidate any in-flight credits lookup
      setKeyInfo(null);
      setEditing(true); // a fresh provider wants its fields filled in right away
      haptics.selection();
    } finally {
      providerOpInFlight.current = false;
    }
  };

  // Delete a provider and fall back to the first remaining one.
  const removeProvider = async (id: string) => {
    await deleteSavedProvider(id);
    const list = await listSavedProviders();
    setProviders(list);
    const fallback = list.find((p) => p.id === getActiveProviderId()) ?? list[0] ?? null;
    setActiveId(fallback?.id ?? null);
    setName(fallback?.name ?? "");
    setBaseUrl(fallback?.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
    setModel(fallback?.model ?? DEFAULT_OPENAI_MODEL);
    setContextLimit(fallback?.contextLimit ? String(fallback.contextLimit) : "");
    const key = fallback ? await getProviderApiKey(fallback.id) : null;
    setApiKey(key ?? "");
    setLoadedKey(key ?? "");
    setHadKey(key != null);
    haptics.selection();
  };

  // Look up the model's context window from models.dev (cached) so we can show
  // it as a hint. Only meaningful for the OpenAI provider; re-runs when the
  // model id changes. Best-effort — null when the model isn't in the catalog.
  useEffect(() => {
    let cancelled = false;
    const id = model.trim();
    contextLimitForModel(id || "\u0000", 0).then((n) => {
      if (!cancelled) setDetectedContext(id && n > 0 ? n : null);
    });
    return () => {
      cancelled = true;
    };
  }, [model]);
  const fetchModels = useCallback(async (base?: string, key?: string) => {
    const b = (base ?? baseUrl).trim() || DEFAULT_OPENAI_BASE_URL;
    const k = (key ?? apiKey).trim();
    if (!k) {
      setModelsError("Enter an API key first.");
      return;
    }
    setFetchingModels(true);
    setModelsError(null);
    try {
      const ids = await listModels(b, k);
      writeModelsCache(b, ids); // persist so the next open hydrates instantly
      setModels(ids);
      if (ids.length === 0) setModelsError("The endpoint returned no models.");
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchingModels(false);
    }
    // Best-effort credits lookup alongside models (never blocks / throws).
    // Guarded by a generation so a slow response can't overwrite state after the
    // active provider changed (or its credits were cleared).
    const gen = ++keyInfoGenRef.current;
    getKeyInfo(b, k)
      .then((info) => { if (gen === keyInfoGenRef.current) setKeyInfo(info); })
      .catch(() => { if (gen === keyInfoGenRef.current) setKeyInfo(null); });
  }, [baseUrl, apiKey]);

  // Auto-populate the model list like desktop's `ensureModels`: hydrate the
  // per-endpoint cache instantly (no network, no tap), then refresh in the
  // background once an API key exists. Debounced so typing a key (or switching
  // providers) doesn't fire a request per keystroke; the generation guard drops
  // superseded ones. Cache hydrate always runs, fetch only with a key.
  const autoFetchGenRef = useRef(0);
  useEffect(() => {
    const base = baseUrl.trim() || DEFAULT_OPENAI_BASE_URL;
    let alive = true;
    const cached = readModelsCache(base);
    if (cached && cached.length > 0) {
      // Async boundary so the synchronous cache hydrate isn't flagged as a
      // setState-in-effect; it lands on the next tick, imperceptibly fast.
      setTimeout(() => {
        if (!alive) return;
        setModels(cached);
        setModelsError(null);
      }, 0);
    }
    if (!apiKey.trim()) return () => { alive = false; };
    const gen = ++autoFetchGenRef.current;
    const t = setTimeout(() => {
      if (gen === autoFetchGenRef.current && alive) void fetchModels(base, apiKey);
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [baseUrl, apiKey, fetchModels]);

  const save = async () => {
    setSaving(true);
    try {
      // Persist the chosen provider. When there's no chooser (only OpenAI is
      // available), force "openai".
      setProviderPref(showChooser ? pref : "openai");
      // Persist the active provider's name (endpoint/model/context route through
      // setOpenAIEndpoint to the active provider), then endpoint + key.
      if (activeId) updateSavedProvider(activeId, { name: name.trim() || "Provider" });
      setOpenAIEndpoint(baseUrl, model, contextLimit.trim() ? parseInt(contextLimit, 10) : undefined);
      // Only touch the keychain if the key field actually changed from what we
      // loaded — avoids a redundant write (and allows clearing it).
      if (apiKey !== loadedKey) await setOpenAIApiKey(apiKey);
      haptics.success(); // settings persisted
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // OpenAI fields show when OpenAI is the effective selection: no chooser (only
  // OpenAI available) or the user picked it explicitly.
  const usingOpenAI = !showChooser || pref === "openai";

  // Case-insensitive filter over the fetched model ids. The selected model is
  // always kept in view (pinned first) even if it doesn't match the query.
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const matches = q ? models.filter((id) => id.toLowerCase().includes(q)) : models;
    if (model && !matches.includes(model) && models.includes(model)) {
      return [model, ...matches];
    }
    return matches;
  }, [models, modelQuery, model]);

  // Enrichment for the collapsed trigger (logo/cost/tool marker), same as the
  // list rows — mirrors the desktop picker's closed-trigger label.
  const triggerInfo = getModelInfo(model);
  const triggerCost = formatModelCost(triggerInfo?.input ?? null, triggerInfo?.output ?? null);
  const triggerNoToolCall = triggerInfo?.toolCall === false;
  // Brand-resolved logo slug: prefers the canonical owner from models.json, then
  // the model's own brand from its id (shared with desktop).
  const triggerLogoProvider = getLogoProvider(model.trim() || DEFAULT_OPENAI_MODEL);

  // Split the filtered list into starred vs the rest so Favorites stay pinned
  // to the top of the dropdown (mirrors desktop's picker sections).
  const { favModels, restModels } = useMemo(() => {
    const fav: string[] = [];
    const rest: string[] = [];
    for (const id of filteredModels) (favorites.has(id) ? fav : rest).push(id);
    return { favModels: fav, restModels: rest };
  }, [filteredModels, favorites]);

  // One row definition shared by the Favorites and All-models sections. The
  // star is a nested pressable so tapping it toggles the favorite without
  // selecting the model (the outer row's onPress never fires).
  const renderModelRow = (id: string) => {
    const active = model === id;
    const info = getModelInfo(id);
    const cost = formatModelCost(info?.input ?? null, info?.output ?? null);
    const noToolCall = info?.toolCall === false;
    const isFavorite = favorites.has(id);
    const rowLogoProvider = getLogoProvider(id);
    return (
      <Pressable
        key={id}
        style={[styles.modelRow, active && styles.modelRowActive]}
        onPress={() => {
          haptics.selection();
          setModel(id);
          setModelOpen(false);
          setModelQuery("");
        }}
        accessibilityRole="button"
        accessibilityLabel={`Model ${id}`}
        accessibilityState={{ selected: active }}
      >
        <Pressable
          style={styles.modelStar}
          onPress={() => toggleFavorite(id)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={isFavorite ? `Unfavorite ${id}` : `Favorite ${id}`}
        >
          <Star
            size={13}
            color={isFavorite ? t.accent : t.textTertiary}
            fill={isFavorite ? t.accent : "transparent"}
          />
        </Pressable>
        {active ? (
          <Check size={14} color={t.accent} />
        ) : (
          <View style={{ width: 14 }} />
        )}
        {rowLogoProvider ? (
          <ProviderLogo provider={rowLogoProvider} />
        ) : (
          <View style={{ width: 14 }} />
        )}
        <Text
          style={[styles.modelRowText, active && styles.modelRowTextActive]}
          numberOfLines={1}
        >
          {id}
        </Text>
        <View style={styles.modelRowMeta}>
          {modelInputChips(info).map((c) => {
            const CapIcon =
              c.key === "text" ? Type
              : c.key === "image" ? ImageIcon
              : c.key === "pdf" ? FileText
              : c.key === "video" ? Video
              : c.key === "audio" ? AudioLines
              : null;
            return CapIcon ? (
              <CapIcon key={c.key} size={10} color={t.textTertiary} />
            ) : null;
          })}
          {noToolCall && (
            <TriangleAlert size={12} color={t.warning} />
          )}
          {cost && (
            <Text style={styles.modelRowCost} numberOfLines={1}>
              {cost}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ headerShown: true, title: "AI settings", headerBackTitle: "Back" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ICON_CHECK}
          variant="done"
          disabled={saving}
          accessibilityLabel="Save AI settings"
          onPress={toolbarPress(save)}
        >
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={t.textTertiary} />
          </View>
        ) : (
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {showChooser ? (
              <>
                <Text style={styles.sectionLabel}>Provider</Text>
                <View style={styles.segment}>
                  {appleAvailable && (
                    <SegmentButton
                      label="Intelligence"
                      icon={Apple}
                      selected={pref === "apple"}
                      onPress={() => setPref("apple")}
                      t={t}
                      styles={styles}
                    />
                  )}
                  {rorkBuiltIn && (
                    <SegmentButton
                      label="Rork"
                      selected={pref === "rork"}
                      onPress={() => setPref("rork")}
                      t={t}
                      styles={styles}
                    />
                  )}
                  <SegmentButton
                    label="OpenAI"
                    selected={pref === "openai"}
                    onPress={() => setPref("openai")}
                    t={t}
                    styles={styles}
                  />
                </View>
                {pref === "apple" && (
                  <View style={styles.rorkNote}>
                    <Cpu size={14} color={t.success} />
                    <Text style={styles.rorkNoteText}>
                      {appleIsServer
                        ? "Apple Intelligence runs on Private Cloud Compute — private, no API key, with a larger context window and stronger reasoning. Needs a connection and has a daily usage limit. Context window: ~32K tokens."
                        : "Apple Intelligence runs entirely on your device — private, offline, no API key. Best for quick chats; it has a small context window, so long conversations may need a fresh start. Context window: ~4K tokens."}
                    </Text>
                  </View>
                )}
                {pref === "apple" && appleIsServer && quota?.available && (
                  <QuotaBar
                    quota={quota}
                    onUpgrade={() => {
                      haptics.selection();
                      showAppleQuotaUpgrade();
                    }}
                    t={t}
                    styles={styles}
                  />
                )}
                {pref === "apple" && appleIsServer && (
                  <View style={styles.reasoningBlock}>
                    <View style={styles.reasoningHead}>
                      <Brain size={13} color={t.textSecondary} />
                      <Text style={styles.sectionLabel}>Reasoning effort</Text>
                    </View>
                    <View style={styles.segment}>
                      {(["light", "moderate", "deep"] as const).map((level) => (
                        <SegmentButton
                          key={level}
                          label={level.charAt(0).toUpperCase() + level.slice(1)}
                          selected={reasoning === level}
                          onPress={() => {
                            haptics.selection();
                            setReasoning(level);
                            setAppleReasoningLevel(level);
                          }}
                          t={t}
                          styles={styles}
                        />
                      ))}
                    </View>
                    <Text style={styles.compatHint}>
                      Deeper reasoning gives stronger multi-step answers but is slower and
                      uses more of the context window.
                    </Text>
                  </View>
                )}
                {pref === "rork" && (
                  <View style={styles.rorkNote}>
                    <ShieldCheck size={14} color={t.success} />
                    <Text style={styles.rorkNoteText}>
                      Rork is built into this app — no configuration needed. Switch to
                      OpenAI-compatible to use your own endpoint and key. Context window:
                      ~200K tokens (estimated).
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <View style={styles.rorkNote}>
                <Text style={styles.rorkNoteText}>
                  {appleReason
                    ? `Apple Intelligence is unavailable: ${appleReason} Configure an OpenAI-compatible endpoint and API key below to enable chat.`
                    : "This build has no bundled AI endpoint. Configure an OpenAI-compatible endpoint and API key below to enable chat."}
                </Text>
              </View>
            )}

            {usingOpenAI && (
              <View style={styles.fields}>
                <ProviderList
                  providers={providers}
                  activeId={activeId}
                  onSelect={switchProvider}
                  onAdd={addProvider}
                  onDelete={removeProvider}
                  providerLogos={providerLogosResolved}
                  t={t}
                  styles={styles}
                />
                {/* Read-only summary for the selected provider — tap Edit to
                    reveal Name / Base URL / API key. Model, Context window,
                    and credits stay always editable/visible. A brand-new
                    provider skips the summary (no values to summarise). */}
                {activeId && !editing ? (
                  <View style={styles.summaryCard}>
                    <View style={styles.summaryHead}>
                      <Text style={styles.summaryName} numberOfLines={1}>{name || "Provider"}</Text>
                      <Pressable
                        style={styles.editBtn}
                        onPress={() => { haptics.selection(); setEditing(true); }}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel="Edit provider"
                      >
                        <Pencil size={12} color={t.accent} />
                        <Text style={styles.editBtnText}>Edit</Text>
                      </Pressable>
                    </View>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Base URL</Text>
                      <Text style={styles.summaryValue} numberOfLines={1}>{baseUrl || DEFAULT_OPENAI_BASE_URL}</Text>
                    </View>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>API key</Text>
                      <Text style={styles.summaryValue}>
                        {hadKey ? "Stored securely in keychain" : "Not set — tap Edit to add one"}
                      </Text>
                    </View>
                  </View>
                ) : (
                <>
                <Field
                  label="Name"
                  value={name}
                  onChangeText={setName}
                  placeholder="OpenAI"
                  t={t}
                  styles={styles}
                />
                <Field
                  label="Base URL"
                  value={baseUrl}
                  onChangeText={setBaseUrl}
                  placeholder={DEFAULT_OPENAI_BASE_URL}
                  autoCapitalize="none"
                  keyboardType="url"
                  t={t}
                  styles={styles}
                />
                <Field
                  label={hadKey ? "API key (stored)" : "API key"}
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={hadKey ? "•••••••• — edit to replace" : "sk-…"}
                  autoCapitalize="none"
                  secureTextEntry
                  t={t}
                  styles={styles}
                />
                </>
                )}
                <View style={styles.keyNote}>
                  <ShieldCheck size={13} color={t.textTertiary} />
                  <Text style={styles.keyNoteText}>
                    Stored securely in the device keychain. Never synced or sent anywhere
                    except your chosen endpoint.
                  </Text>
                </View>

                {keyInfo && (keyInfo.remaining != null || keyInfo.usage != null) && (
                  <View style={styles.creditsCard}>
                    <Wallet size={16} color={t.accent} />
                    <View style={styles.creditsMain}>
                      <Text style={styles.creditsValue}>
                        {keyInfo.remaining != null
                          ? `${formatCredits(keyInfo.remaining)} credits left`
                          : `${formatCredits(keyInfo.usage ?? 0)} used`}
                      </Text>
                      <Text style={styles.creditsSub}>
                        {keyInfo.limit != null
                          ? `of ${formatCredits(keyInfo.limit)} limit${keyInfo.usage != null ? ` · ${formatCredits(keyInfo.usage)} used` : ""}`
                          : keyInfo.isFreeTier
                            ? "Free tier"
                            : "Reported by your provider"}
                      </Text>
                    </View>
                  </View>
                )}

                <View style={styles.field}>
                  <View style={styles.modelHeader}>
                    <Text style={styles.fieldLabel}>Model</Text>
                    <Pressable
                      style={styles.fetchBtn}
                      onPress={() => fetchModels()}
                      disabled={fetchingModels}
                      hitSlop={6}
                    >
                      {fetchingModels ? (
                        <ActivityIndicator size="small" color={t.accent} />
                      ) : (
                        <RefreshCw size={12} color={t.accent} />
                      )}
                      <Text style={styles.fetchBtnText}>
                        {fetchingModels ? "Refreshing…" : "Refresh"}
                      </Text>
                    </Pressable>
                  </View>

                  {customModel ? (
                    <TextInput
                      style={styles.fieldInput}
                      value={model}
                      onChangeText={setModel}
                      placeholder={DEFAULT_OPENAI_MODEL}
                      placeholderTextColor={t.textTertiary}
                      autoCapitalize="none"
                      autoFocus
                      onBlur={() => setCustomModel(false)}
                    />
                  ) : (
                    <Pressable
                      style={[styles.fieldInput, styles.modelTrigger, modelOpen && styles.modelTriggerOpen]}
                      onPress={() => {
                        haptics.selection();
                        setModelOpen((o) => !o);
                        setCustomModel(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Choose model"
                    >
                      {triggerLogoProvider ? (
                        <ProviderLogo provider={triggerLogoProvider} />
                      ) : (
                        <View style={{ width: 14 }} />
                      )}
                      <Text style={styles.modelTriggerText} numberOfLines={1}>
                        {model.trim() || DEFAULT_OPENAI_MODEL}
                      </Text>
                      <View style={styles.modelRowMeta}>
                        {modelInputChips(triggerInfo).map((c) => {
                          const CapIcon =
                            c.key === "text" ? Type
                            : c.key === "image" ? ImageIcon
                            : c.key === "pdf" ? FileText
                            : c.key === "video" ? Video
                            : c.key === "audio" ? AudioLines
                            : null;
                          return CapIcon ? (
                            <CapIcon key={c.key} size={10} color={t.textTertiary} />
                          ) : null;
                        })}
                        {triggerNoToolCall && (
                          <TriangleAlert size={12} color={t.warning} />
                        )}
                        {triggerCost && (
                          <Text style={styles.modelRowCost} numberOfLines={1}>
                            {triggerCost}
                          </Text>
                        )}
                      </View>
                      <ChevronDown
                        size={14}
                        color={t.textTertiary}
                        style={modelOpen ? styles.modelChevronOpen : undefined}
                      />
                    </Pressable>
                  )}

                  {modelsError && !modelOpen && !customModel && (
                    <Text style={styles.modelsError}>{modelsError}</Text>
                  )}

                  {modelOpen && (
                    <>
                      {/* Search box filters the list; "Custom model…" covers ids
                          the endpoint didn't list (gateway/proxy names). */}
                      <TextInput
                        style={styles.modelSearch}
                        value={modelQuery}
                        onChangeText={setModelQuery}
                        placeholder={
                          models.length > 0
                            ? `Search ${models.length} models…`
                            : "No models yet — Refresh, or use Custom model…"
                        }
                        placeholderTextColor={t.textTertiary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        clearButtonMode="while-editing"
                      />
                      {models.length > 0 && (
                        <Text style={styles.modelListMeta}>
                          {modelQuery.trim()
                            ? `${filteredModels.length} of ${models.length} match`
                            : `${models.length} models`}
                        </Text>
                      )}
                      <View style={styles.modelList}>
                        {models.length === 0 ? (
                          <Text style={styles.modelRowEmpty}>
                            No models listed yet — tap Refresh, or enter one under Custom model.
                          </Text>
                        ) : filteredModels.length === 0 ? (
                          <Text style={styles.modelRowEmpty}>No models match “{modelQuery.trim()}”.</Text>
                        ) : (
                          <ScrollView
                            style={{ maxHeight: 240 }}
                            nestedScrollEnabled
                            keyboardShouldPersistTaps="handled"
                          >
                            {favModels.length > 0 && (
                              <>
                                <Text style={styles.modelSectionLabel}>Favorites</Text>
                                {favModels.map(renderModelRow)}
                                {restModels.length > 0 && <View style={styles.modelSectionSeparator} />}
                              </>
                            )}
                            {restModels.map(renderModelRow)}
                          </ScrollView>
                        )}
                      </View>

                      <Pressable
                        style={styles.customRow}
                        onPress={() => {
                          haptics.selection();
                          setCustomModel(true);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Enter a custom model"
                      >
                        <Pencil size={12} color={t.textSecondary} />
                        <Text style={styles.customRowText}>Custom model…</Text>
                      </Pressable>
                    </>
                  )}
                </View>

                <Field
                  label="Context window (tokens)"
                  value={contextLimit}
                  onChangeText={(v) => setContextLimit(v.replace(/[^0-9]/g, ""))}
                  placeholder={detectedContext ? `Auto — ${detectedContext.toLocaleString()}` : "Auto (from models.dev)"}
                  keyboardType="number-pad"
                  t={t}
                  styles={styles}
                />
                <Text style={styles.compatHint}>
                  Sizes the usage ring.{" "}
                  {contextLimit.trim()
                    ? "Using your manual value."
                    : detectedContext
                      ? `Detected ${detectedContext.toLocaleString()} tokens for “${model.trim()}”.`
                      : "Leave blank to detect from the model, or set it for models we can’t look up."}
                </Text>

                <Text style={styles.compatHint}>
                  Works with OpenAI, Azure OpenAI, OpenRouter, Together, Groq, LM Studio,
                  Ollama, and other OpenAI-compatible APIs.
                </Text>
              </View>
            )}

            {usingOpenAI ? (
            <Pressable
              style={styles.navRow}
              onPress={() => {
                haptics.selection();
                router.push("/settings/providers");
              }}
              accessibilityRole="button"
              accessibilityLabel="Browse community AI providers"
            >
              <Server size={16} color={t.textSecondary} />
              <View style={styles.navRowMain}>
                <Text style={styles.navRowTitle}>Browse Providers</Text>
                <Text style={styles.navRowSub}>Add a preset OpenAI-compatible provider from the community catalog — just enter your API key.</Text>
              </View>
              <ChevronRight size={18} color={t.textTertiary} />
            </Pressable>
            ) : null}

            <Pressable
              style={styles.navRow}
              onPress={() => {
                haptics.selection();
                router.push("/settings/tools");
              }}
              accessibilityRole="button"
              accessibilityLabel="Open Tools & Services"
            >
              <Wrench size={16} color={t.textSecondary} />
              <View style={styles.navRowMain}>
                <Text style={styles.navRowTitle}>Tools &amp; Services</Text>
                <Text style={styles.navRowSub}>Connect web search (Tavily, Brave) and other services, and choose which tools the assistant can use.</Text>
              </View>
              <ChevronRight size={18} color={t.textTertiary} />
            </Pressable>
          </ScrollView>
        )}
    </View>
  );
}

