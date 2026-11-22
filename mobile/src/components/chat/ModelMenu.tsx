import { useCallback, useRef, useState, type ReactElement } from "react";
import { PixelRatio } from "react-native";
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
import {
  Button as SUIButton,
  HStack,
  Host,
  Image as SUIImage,
  Menu,
  Section,
  Text as SUIText,
} from "@expo/ui/swift-ui";
import { backgroundOverlay, clipShape, font, foregroundStyle, frame, lineLimit, padding, truncationMode } from "@expo/ui/swift-ui/modifiers";

/** Menus get unwieldy past this; favorites + the current model are always kept. */
const MAX_MODELS = 40;

/**
 * Model/provider switching for Chat, shared by two renderers:
 *  - iOS: a chip in the composer's second row (shown while typing), opening a
 *    native menu — `ModelChip`.
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

/** The provider / favorites / model sections of the SwiftUI model menu. */
function ModelMenuSections({ model: m }: { model: ModelMenuState }) {
  return (
    <>
      {m.providers.length > 1 ? (
        <Section title="Provider">
          {m.providers.map((p) => (
            <SUIButton
              key={p.id}
              label={p.name}
              systemImage={p.id === m.activeId ? "checkmark" : undefined}
              onPress={() => m.pickProvider(p.id)}
            />
          ))}
        </Section>
      ) : null}
      {m.favorites.length > 0 ? (
        <Section title="Favorites">
          {m.favorites.map((name) => (
            <SUIButton
              key={name}
              label={name}
              systemImage={name === m.current ? "checkmark" : "star.fill"}
              onPress={() => m.pickModel(name)}
            />
          ))}
        </Section>
      ) : null}
      <Section title="Model">
        {m.models.map((name) => (
          <SUIButton
            key={name}
            label={name}
            systemImage={name === m.current ? "checkmark" : undefined}
            onPress={() => m.pickModel(name)}
          />
        ))}
      </Section>
    </>
  );
}

/**
 * iOS composer chip: the model id (and, with more than one provider saved, the
 * provider's name, dimmer) in a capsule, opening a native menu of providers and
 * models with a checkmark on the active ones. It sits in the composer's second
 * row, which only shows while typing, so the header no longer spends its title on
 * the model. While a reply is running the chip renders without the menu, so the
 * model can't change mid-turn.
 */
export function ModelChip({ model: m, maxWidth }: { model: ModelMenuState; maxWidth: number }) {
  const t = useTheme();
  // SwiftUI font sizes are fixed points, so apply the OS text-size setting ourselves
  // (RN text does this implicitly) to the theme type-scale tokens.
  const size = Math.round(typeScale.caption.fontSize * PixelRatio.getFontScale());
  const label = (
    // frame(maxWidth) truncates inside the capsule: a long model id
    // ("muse-spark-1.3-contributor") must not push the mic and send buttons off.
    <HStack
      spacing={5}
      alignment="center"
      modifiers={[
        padding({ horizontal: 12, vertical: 7 }),
        backgroundOverlay({ color: withAlpha(t.textPrimary, 0.08) }),
        clipShape("capsule"),
        frame({ maxWidth }),
      ]}
    >
      <SUIText modifiers={[font({ weight: "medium", size }), foregroundStyle(t.textPrimary), lineLimit(1), truncationMode("middle")]}>
        {m.current}
      </SUIText>
      {m.providers.length > 1 ? (
        <SUIText modifiers={[font({ size }), foregroundStyle(t.textTertiary), lineLimit(1)]}>{m.providerName}</SUIText>
      ) : null}
      <SUIImage systemName="chevron.down" size={9} color={t.textSecondary} />
    </HStack>
  );
  return (
    <Host matchContents style={{ maxWidth }}>
      {m.disabled ? (
        label
      ) : (
        <Menu label={label}>
          <ModelMenuSections model={m} />
        </Menu>
      )}
    </Host>
  );
}
