import { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { haptics } from "@/haptics";
import {
  useTheme,
  useAccent,
  setAccentId,
  useIsDark,
  useFont,
  setFontId,
  useChatTheme,
  setChatThemeId,
  resolveRNFontFamily,
  ACCENT_PRESETS,
  FONT_PRESETS,
  type as typeScale,
  type Theme,
} from "@/theme";
import {
  allChatThemes,
  manifestToChatThemes,
  type ChatThemePreset,
} from "@cairn/shared/ui/chat-themes";
import { getCachedThemePresets, fetchChatThemesManifest } from "@/chat/themes-registry";

/**
 * Appearance settings — accent colour, note-text font, and chat theme. Presented
 * as a modal from the Projects header (right of the Sync button). Light/dark
 * follows the system scheme, so this screen covers the things the user can choose.
 */
export default function AppearanceSettingsScreen() {
  const t = useTheme();
  const isDark = useIsDark();
  const accentId = useAccent();
  const fontId = useFont();
  const chatThemeId = useChatTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  // Community chat themes: seed from the on-device cache (works offline) and
  // kick off a background refresh so new catalog themes appear without an app
  // update. Same pattern as the chat personalities picker.
  const [communityThemes, setCommunityThemes] = useState<ChatThemePreset[]>(() =>
    getCachedThemePresets(),
  );
  const [themesLoaded, setThemesLoaded] = useState(getCachedThemePresets().length > 0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { manifest, error } = await fetchChatThemesManifest();
        if (!cancelled) {
          if (manifest) setCommunityThemes(manifestToChatThemes(manifest.themes));
          setThemesLoaded(true);
          if (error) console.warn("[appearance] community themes fetch failed", error);
        }
      } catch (err) {
        if (!cancelled) {
          setThemesLoaded(true);
          console.warn("[appearance] community themes fetch failed", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Built-ins (always available) + community themes, deduped by id.
  const allThemes = useMemo(() => allChatThemes(communityThemes), [communityThemes]);
  const communityCount = communityThemes.length;

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.body}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Accent color</Text>
        <Text style={styles.sectionHint}>
          The highlight color used across the app. Each option is tuned for both light and dark
          themes.
        </Text>
        <View style={styles.list}>
          {ACCENT_PRESETS.map((preset) => {
            const variant = isDark ? preset.dark : preset.light;
            const active = preset.id === accentId;
            return (
              <PressableScale
                key={preset.id}
                style={[styles.row, active && styles.rowActive]}
                onPress={() => {
                  haptics.selection();
                  setAccentId(preset.id);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={preset.name}
              >
                <View style={[styles.swatch, { backgroundColor: variant.accent, borderColor: t.border }]} />
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{preset.name}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {preset.description}
                  </Text>
                </View>
                {active && <Check size={18} color={t.accent} />}
              </PressableScale>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Note font</Text>
        <Text style={styles.sectionHint}>
          Font used for note text — the editor, preview, and PDF export. UI stays on the system
          font.
        </Text>
        <View style={styles.list}>
          {FONT_PRESETS.map((preset) => {
            const active = preset.id === fontId;
            return (
              <PressableScale
                key={preset.id}
                style={[styles.row, active && styles.rowActive]}
                onPress={() => {
                  haptics.selection();
                  setFontId(preset.id);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={preset.name}
              >
                <Text style={[styles.fontSample, { fontFamily: resolveRNFontFamily(preset.id), color: t.textPrimary }]}>
                  Aa
                </Text>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{preset.name}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {preset.description}
                  </Text>
                </View>
                {active && <Check size={18} color={t.accent} />}
              </PressableScale>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Chat theme</Text>
        <Text style={styles.sectionHint}>
          The look of the chat surface — background, bubbles, and chat font. Independent of the
          accent colour and note font.
        </Text>
        <View style={styles.list}>
          {allThemes.map((preset) => {
            const active = preset.id === chatThemeId;
            const isCommunity = preset.community === true;
            return (
              <PressableScale
                key={preset.id}
                style={[styles.row, active && styles.rowActive]}
                onPress={() => {
                  haptics.selection();
                  setChatThemeId(preset.id);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={preset.name}
              >
                <ChatThemeMiniPreview theme={preset} isDark={isDark} />
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>
                    {preset.name}
                    {isCommunity && <Text style={styles.rowCommunity}> · Community</Text>}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {preset.description}
                  </Text>
                </View>
                {active && <Check size={18} color={t.accent} />}
              </PressableScale>
            );
          })}
          {!themesLoaded && communityCount === 0 && (
            <Text style={styles.rowSub}>Loading community themes…</Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

/** Small preview of a chat theme: bg (solid/gradient/pattern) + two bubbles. */
function ChatThemeMiniPreview({ theme, isDark }: { theme: ChatThemePreset; isDark: boolean }) {
  const v = isDark ? theme.dark : theme.light;
  return (
    <View
      style={{
        width: 44,
        height: 34,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "rgba(128,128,128,0.4)",
        padding: 3,
        gap: 3,
        backgroundColor: v.gradient ? v.gradient[0] : v.bg,
      }}
    >
      {v.gradient ? (
        <View
          style={[StyleSheet.absoluteFill, {
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "rgba(128,128,128,0.4)",
            backgroundColor: v.gradient[1],
            opacity: 0.5,
          }]}
        />
      ) : null}
      <View style={{ alignSelf: "flex-start", width: "55%", height: 7, borderRadius: 3, backgroundColor: v.aiBubble, borderWidth: 1, borderColor: "rgba(128,128,128,0.3)" }} />
      <View style={{ alignSelf: "flex-end", width: "55%", height: 7, borderRadius: 3, backgroundColor: v.userBubble }} />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    body: { padding: 18, gap: 20 },
    section: { gap: 8 },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textTertiary, marginBottom: 4 },
    list: { gap: 8 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    rowActive: { borderColor: t.accent, backgroundColor: t.accentDim },
    swatch: { width: 26, height: 26, borderRadius: 999, borderWidth: 1 },
    fontSample: { ...typeScale.title, minWidth: 32, textAlign: "center" },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...typeScale.control, color: t.textPrimary },
    rowCommunity: { ...typeScale.caption, color: t.accent },
    rowSub: { ...typeScale.caption, color: t.textSecondary },
  });
}
