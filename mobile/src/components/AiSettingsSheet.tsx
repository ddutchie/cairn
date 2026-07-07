import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Check, ShieldCheck, RefreshCw } from "lucide-react-native";
import { useTheme, elevation, withAlpha, type Theme } from "@/theme";
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
import { listModels } from "@/chat/providers/openai";

/**
 * AI settings bottom sheet. Lets the user pick the chat backend:
 *   - When a Rork endpoint is built into the app, a segmented toggle chooses
 *     between the built-in Rork provider and a custom OpenAI-compatible one.
 *   - When Rork is NOT built in (third-party builds), only the OpenAI fields
 *     show — Rork isn't an option.
 *
 * Non-secret fields (base URL, model) persist to local SQLite; the API key goes
 * to the device keychain (expo-secure-store). Saved on Done.
 */
export function AiSettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const rorkBuiltIn = isRorkAvailable();

  const [pref, setPref] = useState<ProviderPref>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const [hadKey, setHadKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Model discovery via GET {base}/models.
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Load current values each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setPref(getProviderPref(rorkBuiltIn));
    setBaseUrl(getOpenAIBaseUrl());
    setModel(getOpenAIModel());
    setModels([]);
    setModelsError(null);
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
  }, [visible, rorkBuiltIn]);

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
      setProviderPref(rorkBuiltIn ? pref : "openai");
      setOpenAIEndpoint(baseUrl, model);
      // Only touch the keychain if the key field actually changed from what we
      // loaded — avoids a redundant write (and allows clearing it).
      if (apiKey !== loadedKey) await setOpenAIApiKey(apiKey);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const usingOpenAI = !rorkBuiltIn || pref === "openai";

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={[styles.sheet, elevation.xl]} onPress={() => {}}>
            <View style={styles.grabber} />
            <View style={styles.header}>
              <Pressable onPress={onClose} hitSlop={12}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
              <Text style={styles.title}>AI settings</Text>
            <Pressable onPress={save} hitSlop={12} disabled={saving}>
              {saving ? <ActivityIndicator size="small" color={t.accent} /> : <Text style={styles.done}>Done</Text>}
            </Pressable>
          </View>

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
            {rorkBuiltIn ? (
              <>
                <Text style={styles.sectionLabel}>Provider</Text>
                <View style={styles.segment}>
                  <SegmentButton
                    label="Rork"
                    selected={pref === "rork"}
                    onPress={() => setPref("rork")}
                    t={t}
                    styles={styles}
                  />
                  <SegmentButton
                    label="OpenAI-compatible"
                    selected={pref === "openai"}
                    onPress={() => setPref("openai")}
                    t={t}
                    styles={styles}
                  />
                </View>
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
                  This build has no bundled AI endpoint. Configure an OpenAI-compatible
                  endpoint and API key below to enable chat.
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
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
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
    flex: { flex: 1 },
    // Full-screen dim; the sheet is flowed to the bottom (flex-end) so the
    // KeyboardAvoidingView's padding behaviour genuinely lifts it above the
    // keyboard. Tapping the backdrop (outside the sheet) closes.
    backdrop: { flex: 1, backgroundColor: withAlpha("#000000", 0.4), justifyContent: "flex-end" },
    sheet: {
      maxHeight: "88%",
      backgroundColor: t.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingBottom: 34,
    },
    grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: t.border, marginTop: 8 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    title: { fontSize: 16, fontWeight: "700", color: t.textPrimary },
    cancel: { fontSize: 16, color: t.textTertiary },
    done: { fontSize: 16, fontWeight: "600", color: t.accent },
    loadingBox: { paddingVertical: 48, alignItems: "center" },
    body: { maxHeight: 560 },
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
    segmentText: { fontSize: 14, fontWeight: "600", color: t.textSecondary },
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
    rorkNoteText: { flex: 1, fontSize: 13, color: t.textSecondary, lineHeight: 18 },

    fields: { gap: 14, marginTop: 12 },
    field: { gap: 6 },
    fieldLabel: { fontSize: 13, fontWeight: "600", color: t.textSecondary },
    fieldInput: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      fontSize: 15,
      color: t.textPrimary,
    },
    keyNote: { flexDirection: "row", gap: 6, alignItems: "flex-start", marginTop: -2 },
    keyNoteText: { flex: 1, fontSize: 12, color: t.textTertiary, lineHeight: 16 },
    compatHint: { fontSize: 12, color: t.textTertiary, lineHeight: 16, marginTop: 2 },

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
    fetchBtnText: { fontSize: 12, fontWeight: "600", color: t.accent },
    modelsError: { fontSize: 12, color: t.danger, lineHeight: 16 },
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
    modelChipText: { fontSize: 12, color: t.textSecondary, flexShrink: 1 },
    modelChipTextActive: { color: t.accentFg, fontWeight: "600" },
  });
}
