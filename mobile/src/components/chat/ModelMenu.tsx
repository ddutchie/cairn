import { useCallback, useRef, useState } from "react";
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
import { isRorkAvailable } from "@/chat/providers/rork";
import { ICON_MODEL } from "@/components/toolbar-icons";

/** Menus get unwieldy past this; favorites + the current model are always kept. */
const MAX_MODELS = 40;

/**
 * Header menu to switch the saved provider and its model without leaving the
 * chat (the model picker in the chat-template, here as a native Liquid Glass
 * `Stack.Toolbar.Menu`). Renders INSIDE a `<Stack.Toolbar>`; hidden unless the
 * OpenAI-compatible path is the one the chat actually uses (Rork / Apple On-
 * device have no user-selectable model list).
 *
 * Writes through the same `ai-config` setters as the AI settings sheet, so the
 * two stay in sync; `onChanged` lets the screen re-derive model-dependent state
 * (image-attach gating, usage ring).
 */
export function ModelMenu({ disabled, onChanged }: { disabled?: boolean; onChanged: () => void }) {
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
    setUsable(getProviderPref(isRorkAvailable()) === "openai" && list.length > 0);
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
  const rest = models.filter((m) => m !== current && !favorites.has(m)).sort((a, b) => a.localeCompare(b));
  const pinned = [current, ...[...favorites].filter((m) => m !== current && models.includes(m))];
  const shown = [...pinned, ...rest].slice(0, Math.max(MAX_MODELS, pinned.length));

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

  return (
    <Stack.Toolbar.Menu
      icon={ICON_MODEL}
      iconRenderingMode="template"
      title={current}
      disabled={disabled}
      accessibilityLabel={`Model: ${current}. Switch model`}
    >
      {providers.length > 1 ? (
        <Stack.Toolbar.Menu inline title="Provider">
          {providers.map((p) => (
            <Stack.Toolbar.MenuAction key={p.id} isOn={p.id === active.id} onPress={() => pickProvider(p.id)}>
              {p.name}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      ) : null}
      <Stack.Toolbar.Menu inline title="Model">
        {shown.map((m) => (
          <Stack.Toolbar.MenuAction key={m} isOn={m === current} onPress={() => pickModel(m)}>
            {m}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar.Menu>
  );
}
