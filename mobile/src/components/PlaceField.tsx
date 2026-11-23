import { useMemo, useState } from "react";
import { Text, TextInput, View, StyleSheet } from "react-native";
import { PressableScale } from "@/components/PressableScale";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { searchPlaces, searchZones } from "@cairn/shared/people/place-zone";

export type PlaceFieldMode = "location" | "timezone";

interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  /** What to save, and for a location the zone it implies. */
  text: string;
  zone?: string;
}

/** Cities (biggest first) for a location; for a time zone, zone names first, then the zones of matching cities. */
function suggestionsFor(mode: PlaceFieldMode, query: string): Suggestion[] {
  const cities = searchPlaces(query);
  if (mode === "location") return cities.map((c) => ({ key: c.label, label: c.label, detail: c.zone, text: c.label, zone: c.zone }));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const z of searchZones(query)) { seen.add(z); out.push({ key: `z:${z}`, label: z, text: z }); }
  for (const c of cities) {
    if (seen.has(c.zone)) continue;
    seen.add(c.zone);
    out.push({ key: `c:${c.label}`, label: c.zone, detail: c.label, text: c.zone });
  }
  return out.slice(0, 8);
}

/**
 * A text field for a place or a time zone with suggestions as you type, as on the desktop. Free text still saves;
 * picking a suggestion fills the field (and, for a location, reports the zone it implies). The list stays until
 * you pick one, clear the field or the sheet closes.
 */
export function PlaceField({ value, mode, onChangeText, onPick, placeholder, accessibilityLabel }: {
  value: string;
  mode: PlaceFieldMode;
  onChangeText: (text: string) => void;
  onPick: (text: string, zone?: string) => void;
  placeholder?: string;
  accessibilityLabel: string;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [dismissed, setDismissed] = useState(true);
  const suggestions = useMemo(() => (dismissed ? [] : suggestionsFor(mode, value)), [dismissed, mode, value]);
  // Nothing to suggest once the field already reads exactly as a suggestion.
  const showing = suggestions.length > 0 && !suggestions.some((x) => x.text === value.trim());

  return (
    <View>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={(text) => { onChangeText(text); setDismissed(false); }}
        placeholder={placeholder}
        placeholderTextColor={t.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => setDismissed(true)}
        // The list belongs to the field being typed in: it opens on focus and closes when you leave.
        onFocus={() => setDismissed(false)}
        onBlur={() => setDismissed(true)}
        accessibilityLabel={accessibilityLabel}
      />
      {showing ? (
        <View style={s.list} accessibilityLabel={`${accessibilityLabel} suggestions`}>
          {suggestions.map((sug) => (
            <PressableScale
              key={sug.key}
              onPress={() => { onPick(sug.text, sug.zone); setDismissed(true); }}
              style={s.row}
              accessibilityLabel={sug.detail ? `${sug.label}, ${sug.detail}` : sug.label}
            >
              <Text style={s.label} numberOfLines={1}>{sug.label}</Text>
              {sug.detail ? <Text style={s.detail} numberOfLines={1}>{sug.detail}</Text> : null}
            </PressableScale>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    input: {
      ...typeScale.body, color: t.textPrimary, marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    list: {
      marginTop: 4, borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, overflow: "hidden",
    },
    row: {
      flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12,
      paddingVertical: 9, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border,
    },
    label: { ...typeScale.caption, color: t.textPrimary, flexShrink: 1 },
    detail: { ...typeScale.caption, color: t.textTertiary, flexShrink: 0 },
  });
}
