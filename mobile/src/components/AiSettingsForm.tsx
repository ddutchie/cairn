import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Stack } from "expo-router";
import { Check, ShieldCheck, RefreshCw, Cpu, Apple, Brain } from "lucide-react-native";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { useTheme } from "@/theme";
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
  type ProviderPref,
} from "@/chat/ai-config";
import { isRorkAvailable } from "@/chat/providers/rork";
import {
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
import { listModels } from "@/chat/providers/openai";
import { contextLimitForModel } from "@/chat/models-dev";
import { useAiSettingsStyles } from "./ai-settings/styles";
import { SegmentButton } from "./ai-settings/SegmentButton";
import { Field } from "./ai-settings/Field";
import { QuotaBar } from "./ai-settings/QuotaBar";

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

  // Load the API key (async, from secure store) once on mount. The synchronous
  // provider/baseUrl/model values are already seeded above.
  useEffect(() => {
    let cancelled = false;
    getOpenAIApiKey().then((k) => {
      if (cancelled) return;
      setHadKey(k != null);
      setApiKey(k ?? "");
      setLoadedKey(k ?? "");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const fetchModels = async () => {
    const key = apiKey.trim();
    if (!key) {
      setModelsError("Enter an API key first.");
      return;
    }
    setFetchingModels(true);
    setModelsError(null);
    try {
      const ids = await listModels(baseUrl.trim() || DEFAULT_OPENAI_BASE_URL, key);
      setModels(ids);
      if (ids.length === 0) setModelsError("The endpoint returned no models.");
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // Persist the chosen provider. When there's no chooser (only OpenAI is
      // available), force "openai".
      setProviderPref(showChooser ? pref : "openai");
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
                <View style={styles.keyNote}>
                  <ShieldCheck size={13} color={t.textTertiary} />
                  <Text style={styles.keyNoteText}>
                    Stored securely in the device keychain. Never synced or sent anywhere
                    except your chosen endpoint.
                  </Text>
                </View>

                <View style={styles.field}>
                  <View style={styles.modelHeader}>
                    <Text style={styles.fieldLabel}>Model</Text>
                    <Pressable
                      style={styles.fetchBtn}
                      onPress={fetchModels}
                      disabled={fetchingModels}
                      hitSlop={6}
                    >
                      {fetchingModels ? (
                        <ActivityIndicator size="small" color={t.accent} />
                      ) : (
                        <RefreshCw size={12} color={t.accent} />
                      )}
                      <Text style={styles.fetchBtnText}>
                        {fetchingModels ? "Fetching…" : "Fetch models"}
                      </Text>
                    </Pressable>
                  </View>
                  <TextInput
                    style={styles.fieldInput}
                    value={model}
                    onChangeText={setModel}
                    placeholder={DEFAULT_OPENAI_MODEL}
                    placeholderTextColor={t.textTertiary}
                    autoCapitalize="none"
                  />
                  {modelsError && <Text style={styles.modelsError}>{modelsError}</Text>}
                  {models.length > 0 && (
                    <View style={styles.modelChips}>
                      {models.map((id) => (
                        <Pressable
                          key={id}
                          style={[styles.modelChip, model === id && styles.modelChipActive]}
                          onPress={() => setModel(id)}
                        >
                          {model === id && <Check size={11} color={t.accentFg} />}
                          <Text
                            style={[styles.modelChipText, model === id && styles.modelChipTextActive]}
                            numberOfLines={1}
                          >
                            {id}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
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
          </ScrollView>
        )}
    </View>
  );
}

