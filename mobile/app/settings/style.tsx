import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ModalSafeView } from "@/components/ModalSafeView";
import { getUserStyle } from "@/db/queries";
import { formatRelative } from "@cairn/shared/format/date";
import { useEdgePad } from "@/lib/use-edge-pad";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/** Settings, Writing style: read-only for now. Desktop writes it; sync brings it here for chat to draft in your voice. */
export default function WritingStyleScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const edge = useEdgePad(18);
  const style = getUserStyle();
  const persona = style?.persona;
  const personaLines = persona
    ? ([["Name", persona.name], ["Role", persona.role], ["Context", persona.context], ["Audiences", persona.audiences]] as const).filter(([, v]) => !!v)
    : [];

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <ScrollView style={s.flex} contentContainerStyle={[s.body, edge]} contentInsetAdjustmentBehavior="automatic">
        {!style ? (
          <Text style={s.hint}>No writing style yet. Create one in Cairn on your computer (Settings, Writing style) and it syncs here.</Text>
        ) : (
          <>
            <Text style={s.hint}>
              Chat uses this to draft in your voice. Edit it on desktop; changes sync here. Updated {formatRelative(style.updatedAt)}.
            </Text>
            {personaLines.length > 0 ? (
              <Block label="About you" s={s}>
                {personaLines.map(([k, v]) => (
                  <Text key={k} style={s.text}><Text style={s.key}>{k}: </Text>{v}</Text>
                ))}
              </Block>
            ) : null}
            {style.cheatsheet ? <Block label="Cheatsheet" s={s}><Text style={s.text}>{style.cheatsheet}</Text></Block> : null}
            {style.fullGuide ? <Block label="Full guide" s={s}><Text style={s.text}>{style.fullGuide}</Text></Block> : null}
          </>
        )}
      </ScrollView>
    </ModalSafeView>
  );
}

function Block({ label, s, children }: { label: string; s: ReturnType<typeof makeStyles>; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.label}>{label}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    body: { padding: 18, gap: 18, paddingBottom: 80 },
    hint: { ...typeScale.caption, color: t.textTertiary },
    section: { gap: 8 },
    label: { ...typeScale.overline, color: t.textTertiary },
    card: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 12, gap: 6 },
    text: { ...typeScale.body, color: t.textPrimary },
    key: { color: t.textSecondary },
  });
}
