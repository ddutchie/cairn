import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Stack } from "expo-router";
import { Check, ShieldCheck, RefreshCw, Cpu } from "lucide-react-native";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  getOpenAIApiKey,
  getOpenAIBaseUrl,
  getOpenAIModel,
  getProviderPref,
  setOpenAIApiKey,
  setOpenAIEndpoint,
  setProviderPref,
  type ProviderPref,
} from "@/chat/ai-config";
import { isRorkAvailable } from "@/chat/providers/rork";
import { isAppleProviderAvailable, isAppleDevEnabled } from "@/chat/providers/apple";
import { appleLlmUnavailableReason } from "@modules/apple-llm";
import { listModels } from "@/chat/providers/openai";

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
  const styles = useMemo(() => makeStyles(t), [t]);
  const rorkBuiltIn = isRorkAvailable();
  const appleAvailable = isAppleProviderAvailable();
  // Only surface an Apple availability reason when Apple is a dev-enabled option
  // (isAppleProviderAvailable already false when the dev flag is off, so this
  // stays empty in shipped builds and no Apple messaging leaks to end users).
  const appleReason = useMemo(
    () => (isAppleDevEnabled() && !appleAvailable ? appleLlmUnavailableReason() : ""),
    [appleAvailable],
  );
  // Whether to show the provider chooser at all: only when there's a choice.
  const showChooser = rorkBuiltIn || appleAvailable;

  // These initial values come from synchronous getters, so seed them via lazy
  // useState initializers (run once) rather than assigning in an effect — the
  // latter is a cascading setState-in-effect the linter flags. The API key is
  // async (secure store), so it's loaded in the effect below.
  const [pref, setPref] = useState<ProviderPref>(() => getProviderPref(rorkBuiltIn));
  const [baseUrl, setBaseUrl] = useState(() => getOpenAIBaseUrl());
  const [model, setModel] = useState(() => getOpenAIModel());
  const [apiKey, setApiKey] = useState("");
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
      setOpenAIEndpoint(baseUrl, model);
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
                      label="On-device"
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
                      Apple Intelligence runs entirely on your device — private, offline,
                      no API key. Best for quick chats; it has a small context window, so
                      long conversations may need a fresh start.
                    </Text>
                  </View>
                )}
                {pref === "rork" && (
                  <View style={styles.rorkNote}>
                    <ShieldCheck size={14} color={t.success} />
                    <Text style={styles.rorkNoteText}>
                      Rork is built into this app — no configuration needed. Switch to
                      OpenAI-compatible to use your own endpoint and key.
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <View style={styles.rorkNote}>
                <Text style={styles.rorkNoteText}>
                  {appleReason
                    ? `On-device AI is unavailable: ${appleReason} Configure an OpenAI-compatible endpoint and API key below to enable chat.`
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

function SegmentButton({
  label,
  selected,
  onPress,
  t,
  styles,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      style={[styles.segmentBtn, selected && styles.segmentBtnActive]}
      onPress={onPress}
    >
      {selected && <Check size={13} color={t.accentFg} />}
      <Text style={[styles.segmentText, selected && styles.segmentTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Field({
  label,
  t,
  styles,
  ...input
}: {
  label: string;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
} & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        placeholderTextColor={t.textTertiary}
        {...input}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    loadingBox: { paddingVertical: 48, alignItems: "center" },
    body: { flex: 1 },
    bodyContent: { padding: 18, gap: 8 },

    sectionLabel: {
      fontSize: 12,
      fontWeight: "600",
      color: t.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 2,
    },
    segment: {
      flexDirection: "row",
      gap: 6,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      padding: 4,
    },
    segmentBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      paddingVertical: 9,
      borderRadius: 9,
    },
    segmentBtnActive: { backgroundColor: t.accent },
    segmentText: { ...typeScale.control, color: t.textSecondary },
    segmentTextActive: { color: t.accentFg },

    rorkNote: {
      flexDirection: "row",
      gap: 8,
      alignItems: "flex-start",
      backgroundColor: t.surface2,
      borderRadius: 10,
      padding: 12,
      marginTop: 4,
    },
    rorkNoteText: { flex: 1, ...typeScale.caption, color: t.textSecondary, lineHeight: 18 },

    fields: { gap: 14, marginTop: 12 },
    field: { gap: 6 },
    fieldLabel: { ...typeScale.label, color: t.textSecondary },
    fieldInput: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      ...typeScale.body,
      color: t.textPrimary,
    },
    keyNote: { flexDirection: "row", gap: 6, alignItems: "flex-start", marginTop: -2 },
    keyNoteText: { flex: 1, ...typeScale.caption, color: t.textTertiary, lineHeight: 16 },
    compatHint: { ...typeScale.caption, color: t.textTertiary, lineHeight: 16, marginTop: 2 },

    modelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    fetchBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: t.accentDim,
    },
    fetchBtnText: { ...typeScale.label, color: t.accent },
    modelsError: { ...typeScale.caption, color: t.danger, lineHeight: 16 },
    modelChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
    modelChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    modelChipActive: { backgroundColor: t.accent, borderColor: t.accent },
    modelChipText: { ...typeScale.caption, color: t.textSecondary, flexShrink: 1 },
    modelChipTextActive: { color: t.accentFg, fontWeight: "600" },
  });
}
