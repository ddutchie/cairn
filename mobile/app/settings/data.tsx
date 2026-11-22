import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import * as SQLite from "expo-sqlite";
import { Directory, File } from "expo-file-system";
import { ModalSafeView } from "@/components/ModalSafeView";
import { dataCounts } from "@/db/queries";
import { formatBytesBinary } from "@cairn/shared/format/number";
import { useEdgePad } from "@/lib/use-edge-pad";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/** Bytes the local databases take on this phone (every workspace copy; the notes themselves live in the DB). */
function databaseBytes(): number | null {
  try {
    return new Directory(SQLite.defaultDatabaseDirectory).list().reduce((n, f) => (f instanceof File ? n + (f.size ?? 0) : n), 0);
  } catch {
    return null;
  }
}

/** Settings, Data: what this phone holds. Reset stays in the database-error recovery screen for now. */
export default function DataSettingsScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const edge = useEdgePad(18);
  const c = dataCounts();
  const bytes = databaseBytes();
  const rows: [string, string][] = [
    ["Storage used", bytes == null ? "Unknown" : formatBytesBinary(bytes)],
    ["Projects", String(c.projects)],
    ["Notes", String(c.notes)],
    ["Tasks", String(c.tasks)],
    ["Tags", String(c.tags)],
    ["People", String(c.people)],
  ];
  return (
    <ModalSafeView backgroundColor={t.surface}>
      <ScrollView style={s.flex} contentContainerStyle={[s.body, edge]} contentInsetAdjustmentBehavior="automatic">
        <Text style={s.hint}>What this phone holds for the open workspace. Your data syncs through the shared folder (Sync).</Text>
        <View style={s.card}>
          {rows.map(([k, v], i) => (
            <View key={k} style={[s.row, i > 0 && s.rowBorder]}>
              <Text style={s.k}>{k}</Text>
              <Text style={s.v}>{v}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </ModalSafeView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    body: { padding: 18, gap: 14 },
    hint: { ...typeScale.caption, color: t.textTertiary },
    card: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 12 },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 12 },
    rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
    k: { ...typeScale.control, color: t.textPrimary },
    v: { ...typeScale.control, color: t.textSecondary, fontVariant: ["tabular-nums"] },
  });
}
