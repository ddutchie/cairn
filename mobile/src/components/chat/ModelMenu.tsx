import { useCallback, useRef, useState, type ComponentRef, type ReactElement } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { Stack, useFocusEffect } from "expo-router";
import {
  getActiveProvider,
  getFavoriteModels,
  getProviderApiKey,
  getProviderPref,
  listSavedProviders,
  readModelsCache,
  selectSavedProvider,
  setOpenAIEndpoint,
  writeModelsCache,
  type SavedProvider,
} from "@/chat/ai-config";
import { listModels } from "@/chat/providers/openai";
import { ICON_MODEL } from "@/components/toolbar-icons";
import { type as typeScale, useTheme, withAlpha } from "@/theme";

/** Menus get unwieldy past this; favorites + the current model are always kept. */
const MAX_MODELS = 40;

/**
 * Model/provider switching for Chat, shared by two renderers:
 *  - iOS: a chip in the composer's second row (shown while typing), opening the
 *    chat panel's model view — `ModelChip` (the rows are built by the screen).
 *  - Android: a `Stack.Toolbar.Menu` in the header's right toolbar —
 *    `modelToolbarMenu`.
 * Hidden unless the OpenAI-compatible path is the one the chat actually uses
 * (Apple On-device has no user-selectable model list).
 *
 * `Stack.Toolbar` keeps only children that are literally Button/Menu/Spacer/View
 * elements (`isChildOfType`), so the toolbar variant is a function returning the
 * real element — a wrapper component placed inside it is silently dropped.
 *
 * Writes through the same `ai-config` setters as the AI settings sheet, so the
 * two stay in sync; `onChanged` lets the screen re-derive model-dependent state
 * (image-attach gating, usage ring).
 */
export interface ModelMenuState {
  current: string;
  /** Display name of the active provider (title line above the model id). */
  providerName: string;
  providers: SavedProvider[];
  activeId: string;
  /** Favorite models (A–Z), shown in their own section above `models`. */
  favorites: string[];
  /** Current model first (when not a favorite), then the rest A–Z (capped). */
  models: string[];
  disabled: boolean;
  pickModel: (model: string) => void;
  pickProvider: (id: string) => void;
}

export function useModelMenuState({ disabled = false, onChanged }: { disabled?: boolean; onChanged: () => void }): ModelMenuState | null {
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [active, setActive] = useState<SavedProvider | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [usable, setUsable] = useState(false);

  // Bumped by every load and on blur; a load only commits while it is still the
  // latest, so a slow response for provider A can't land under provider B.
  const loadGen = useRef(0);
  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    const current = () => gen === loadGen.current;
    const list = await listSavedProviders();
    if (!current()) return;
    const act = getActiveProvider();
    setUsable(getProviderPref() === "openai" && list.length > 0);
    setProviders(list);
    setActive(act);
    setFavorites(getFavoriteModels());
    if (!act) return;
    const cached = readModelsCache(act.baseUrl);
    setModels(cached ?? []);
    if (cached) return;
    // First open for this endpoint: fetch once and cache (same cache the
    // settings sheet reads), so the menu fills in without a trip there.
    try {
      const ids = await listModels(act.baseUrl, (await getProviderApiKey(act.id)) ?? "");
      if (current() && ids.length > 0) {
        writeModelsCache(act.baseUrl, ids);
        setModels(ids);
      }
    } catch {
      /* offline / keyless endpoint without /models — current model still shown */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { loadGen.current++; };
    }, [load]),
  );

  if (!usable || !active) return null;

  const current = active.model;
  const favs = [...favorites].filter((m) => m === current || models.includes(m)).sort((a, b) => a.localeCompare(b));
  const rest = models.filter((m) => m !== current && !favorites.has(m)).sort((a, b) => a.localeCompare(b));
  const lead = favorites.has(current) ? [] : [current];
  const shown = [...lead, ...rest].slice(0, Math.max(MAX_MODELS - favs.length, lead.length));

  const pickModel = (model: string) => {
    if (model === current) return;
    setOpenAIEndpoint(active.baseUrl, model, active.contextLimit);
    setActive({ ...active, model });
    onChanged();
  };
  const pickProvider = (id: string) => {
    if (id === active.id) return;
    selectSavedProvider(id);
    void load();
    onChanged();
  };

  return { current, providerName: active.name, providers, activeId: active.id, favorites: favs, models: shown, disabled, pickModel, pickProvider };
}

/** Right-toolbar variant (Android, which has no SwiftUI menu for the chip). */
export function modelToolbarMenu(m: ModelMenuState | null): ReactElement | null {
  if (!m) return null;
  return (
    <Stack.Toolbar.Menu
      icon={ICON_MODEL}
      iconRenderingMode="template"
      title={m.current}
      disabled={m.disabled}
      accessibilityLabel={`Model: ${m.current}. Switch model`}
    >
      {m.providers.length > 1 ? (
        <Stack.Toolbar.Menu inline title="Provider">
          {m.providers.map((p) => (
            <Stack.Toolbar.MenuAction key={p.id} isOn={p.id === m.activeId} onPress={() => m.pickProvider(p.id)}>
              {p.name}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      ) : null}
      {m.favorites.length > 0 ? (
        <Stack.Toolbar.Menu inline title="Favorites">
          {m.favorites.map((name) => (
            <Stack.Toolbar.MenuAction key={name} isOn={name === m.current} onPress={() => m.pickModel(name)}>
              {name}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      ) : null}
      <Stack.Toolbar.Menu inline title="Model">
        {m.models.map((name) => (
          <Stack.Toolbar.MenuAction key={name} isOn={name === m.current} onPress={() => m.pickModel(name)}>
            {name}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar.Menu>
  );
}

/**
 * iOS composer chip: the model id (and, with more than one provider saved, the
 * provider's name, dimmer) in a capsule. It sits in the composer's second row,
 * which only shows while typing. Tapping it opens the chat panel's model view
 * (provider, model and tuning) growing out of the chip; `onOpen` gets the chip's
 * centre x in the window. While a reply is running it can't be tapped, so the
 * model can't change mid-turn.
 */
export function ModelChip({ model: m, onOpen }: { model: ModelMenuState; onOpen: (centerX: number) => void }) {
  const t = useTheme();
  const ref = useRef<ComponentRef<typeof Pressable>>(null);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={`Model: ${m.current}${m.providers.length > 1 ? `, ${m.providerName}` : ""}. Model and settings`}
      accessibilityState={{ disabled: m.disabled }}
      disabled={m.disabled}
      hitSlop={6}
      onPress={() => ref.current?.measureInWindow((x, _y, w) => onOpen(x + w / 2))}
      style={[chipStyles.chip, { backgroundColor: withAlpha(t.textPrimary, 0.08) }]}
    >
      <Text style={[typeScale.caption, chipStyles.model, { color: t.textPrimary }]} numberOfLines={1} ellipsizeMode="middle">
        {m.current}
      </Text>
      {m.providers.length > 1 ? (
        <Text style={[typeScale.caption, chipStyles.provider, { color: t.textTertiary }]} numberOfLines={1}>
          {m.providerName}
        </Text>
      ) : null}
      <ChevronDown size={12} color={t.textSecondary} strokeWidth={2.25} />
    </Pressable>
  );
}

const chipStyles = StyleSheet.create({
  // Shrinks within the composer's chip slot (flex: 1), so a long id truncates before the mic and send buttons.
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, minWidth: 0, flexShrink: 1 },
  model: { fontWeight: "500", flexShrink: 1 },
  provider: { flexShrink: 2 },
});
