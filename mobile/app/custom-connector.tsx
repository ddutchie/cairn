import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { parseCustomMcp } from "@cairn/shared/chat/custom-connector";
import { addCustomMcpServer, refreshServerTools } from "@/chat/mcp-store";
import { startAuth } from "@/chat/mcp-oauth";
import { ModalSafeView } from "@/components/ModalSafeView";
import { ScreenChrome } from "@/components/screen-chrome";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { toolbarPress, useModalOpenHaptic, haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Add your own MCP server: a URL, optionally with OAuth and your own app's client id.
 * For providers that are not in the registry or do not offer dynamic registration
 * (a Microsoft 365 tenant app, a vendor's private server). Stays on this device.
 */
export default function CustomConnectorForm() {
  useModalOpenHaptic();
  const router = useRouter();
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [oauth, setOauth] = useState(true);
  const [scope, setScope] = useState("");
  const [clientId, setClientId] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const canSave = name.trim().length > 0 && url.trim().length > 0 && !busy;

  const save = async () => {
    if (!canSave || submitting.current) return;
    const parsed = parseCustomMcp({ name, url, authMode: oauth ? "oauth" : "none", scope, clientId, redirectUri });
    if (!parsed.ok) {
      Alert.alert("Check the connector", parsed.error);
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const server = addCustomMcpServer(parsed.value);
      if (server.authMode === "oauth") {
        const res = await startAuth(
          { id: server.id, serverUrl: server.baseUrl, scope: server.oauthScope, clientId: server.oauthClientId, redirectUri: server.oauthRedirectUri },
          server.name,
        );
        if (res.status === "error") {
          // It stays added: Connect on the Tools screen tries again once the app registration is fixed.
          Alert.alert(res.desktopOnly ? "Added, but it wouldn't sign in" : "Added, but sign-in failed", res.error);
        } else if (res.status === "authorized") {
          haptics.success();
        }
      }
      await refreshServerTools(server.id).catch(() => null);
      router.back();
    } catch (e) {
      submitting.current = false;
      setBusy(false);
      Alert.alert("Couldn't add the connector", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenChrome
          title="Custom connector"
          right={[{ kind: "button", key: "save", label: "Add", icon: ICON_CHECK, variant: "done", hidden: !canSave, onPress: () => toolbarPress(() => void save(), "confirm")() }]}
        />
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>Name</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Microsoft 365" placeholderTextColor={t.textTertiary} autoFocus />

          <Text style={s.label}>MCP server URL</Text>
          <TextInput
            style={s.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://"
            placeholderTextColor={t.textTertiary}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={s.hint}>Streamable HTTP, https only. The connector stays on this device and is never synced.</Text>

          <Text style={s.label}>Sign-in</Text>
          <View style={s.chipRow}>
            {([[true, "OAuth"], [false, "None"]] as const).map(([v, label]) => (
              <Pressable
                key={label}
                onPress={() => { haptics.selection(); setOauth(v); }}
                accessibilityRole="button"
                accessibilityState={{ selected: oauth === v }}
                style={[s.chip, { borderColor: oauth === v ? t.accent : t.border }, oauth === v && { backgroundColor: t.accent }]}
              >
                <Text style={[s.chipText, { color: oauth === v ? t.accentFg : t.textSecondary }]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {oauth ? (
            <>
              <Text style={s.label}>Your app&apos;s client ID (optional)</Text>
              <TextInput style={s.input} value={clientId} onChangeText={(v) => { setClientId(v); if (!v.trim()) setRedirectUri(""); }} placeholder="Leave empty to register automatically" placeholderTextColor={t.textTertiary} autoCapitalize="none" autoCorrect={false} />
              <Text style={s.hint}>
                Needed when the provider has no automatic registration, such as a Microsoft 365 tenant: register an app there as a public client and paste its ID. No secret is stored.
              </Text>

              {clientId.trim() ? (
                <>
                  <Text style={s.label}>Redirect URI (optional)</Text>
                  <TextInput style={s.input} value={redirectUri} onChangeText={setRedirectUri} placeholder="https://gerardbuilds.com/cairn/oauth" placeholderTextColor={t.textTertiary} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                  <Text style={s.hint}>Register this exact address on your app. Leave empty for the one above, or use cairn://oauth/callback.</Text>
                </>
              ) : null}

              <Text style={s.label}>Scopes (optional)</Text>
              <TextInput style={s.input} value={scope} onChangeText={setScope} placeholder="space separated" placeholderTextColor={t.textTertiary} autoCapitalize="none" autoCorrect={false} />
            </>
          ) : null}

          {busy ? <ActivityIndicator style={{ marginTop: 24 }} color={t.accent} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </ModalSafeView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    content: { padding: 18, paddingBottom: 60 },
    label: { ...typeScale.overline, color: t.textTertiary, marginTop: 18, marginBottom: 8 },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 8 },
    input: { ...typeScale.body, color: t.textPrimary, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    chipRow: { flexDirection: "row", gap: 8 },
    chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    chipText: { ...typeScale.label },
  });
}
