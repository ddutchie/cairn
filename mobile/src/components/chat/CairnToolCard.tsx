import { useMemo, useState, type ReactNode } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CheckCircle, ChevronRight } from "lucide-react-native";
import {
  cairnToolView,
  type ChangeRowData,
  type ToolBlock,
  type ToolPanelData,
} from "@cairn/shared/conversation/tool-view";
import { redactValue } from "@cairn/shared/chat/redaction";
import { useTheme, type as typeScale, withAlpha, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import type { ToolCall } from "@/db/chat-store";
import { prettyToolOutput, safeToolOutput } from "@/chat/tool-output";
import { DisclosureTurn, useDisclosure } from "@/components/Disclosure";

/**
 * A settled Cairn data-tool call as an expandable card: the humanized chip as the
 * header, then what the call changed (field rows, +/- diff, hit lists; the same
 * view-model the desktop transcript renders) and a "Raw call" section with the
 * arguments and result. A note or task the call touched stays one tap away as an
 * Open button in the header.
 */
export function CairnToolCard({ tool, label, onOpen }: { tool: ToolCall; label: string; onOpen?: () => void }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [expanded, setExpanded] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const disclosure = useDisclosure(expanded);
  const rawDisclosure = useDisclosure(rawOpen);
  const panels = useMemo(
    () => cairnToolView({ name: tool.tool, args: tool.args, output: tool.output, ok: tool.ok }),
    [tool.tool, tool.args, tool.output, tool.ok],
  );
  const args = tool.args && Object.keys(tool.args).length > 0 ? prettyToolOutput(safeToolOutput(tool.args)) : undefined;
  const output = prettyToolOutput(safeToolOutput(tool.output));
  const raw = args || output;
  const failure = !tool.ok ? errorText(tool.output) : undefined;

  return (
    <View style={[styles.card, expanded && styles.cardOpen]}>
      <View style={styles.header}>
        <Pressable
          style={styles.headerMain}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label}`}
          accessibilityState={{ expanded }}
          onPress={() => {
            haptics.impact();
            setExpanded((v) => !v);
          }}
        >
          <CheckCircle size={10} color={tool.ok ? t.accent : t.danger} />
          <Text style={styles.label} numberOfLines={1}>{label}</Text>
          <DisclosureTurn progress={disclosure.progress}>
            <ChevronRight size={12} color={t.textTertiary} />
          </DisclosureTurn>
        </Pressable>
        {onOpen ? (
          <Pressable style={styles.open} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open ${label}`} onPress={() => { haptics.impact(); onOpen(); }}>
            <Text style={styles.openText}>Open</Text>
          </Pressable>
        ) : null}
      </View>
      {disclosure.mounted ? (
        <View style={styles.body}>
          {failure ? <Panel data={{ label: "Error", tone: "danger", blocks: [{ type: "text", text: failure }] }} t={t} styles={styles} /> : null}
          {panels?.map((p, i) => <Panel key={i} data={p} t={t} styles={styles} />)}
          {raw ? (
            <View>
              <Pressable
                style={styles.rawToggle}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`${rawOpen ? "Hide" : "Show"} raw call`}
                accessibilityState={{ expanded: rawOpen }}
                onPress={() => setRawOpen((v) => !v)}
              >
                <DisclosureTurn progress={rawDisclosure.progress}>
                  <ChevronRight size={11} color={t.textTertiary} />
                </DisclosureTurn>
                <Text style={styles.rawLabel}>Raw call</Text>
              </Pressable>
              {rawDisclosure.mounted ? (<View>
                {args ? <RawPayload label="Arguments" value={args} styles={styles} /> : null}
                {output ? <RawPayload label="Result" value={output} styles={styles} /> : null}
              </View>) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Whether a settled Cairn call has anything to expand (a view, arguments, or a result). */
export function hasToolDetail(tool: ToolCall): boolean {
  return !!tool.output || (!!tool.args && Object.keys(tool.args).length > 0);
}

function errorText(output: string | undefined): string | undefined {
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return redactValue(parsed.error) as string;
    return undefined;
  } catch {
    return redactValue(output) as string;
  }
}

type Styles = ReturnType<typeof makeStyles>;

function RawPayload({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.payload}>
      <Text style={styles.payloadLabel}>{label}</Text>
      <Text style={styles.payloadText} selectable>{value}</Text>
    </View>
  );
}

function Panel({ data, t, styles }: { data: ToolPanelData; t: Theme; styles: Styles }) {
  return (
    <View
      style={[styles.panel, data.tone === "danger" && { borderColor: withAlpha(t.danger, 0.4) }]}
      accessible={false}
    >
      <Text style={styles.panelLabel} accessibilityRole="header">{data.label}</Text>
      {data.blocks.map((b, i) => <Block key={i} block={b} t={t} styles={styles} />)}
    </View>
  );
}

function Rows({ rows, styles }: { rows: ChangeRowData[]; styles: Styles }) {
  return (
    <View style={styles.rows}>
      {rows.map((r, i) => <ChangeRow key={`${r.field}-${i}`} row={r} styles={styles} />)}
    </View>
  );
}

/** `field  from → to`, read aloud as "field, from X to Y". */
function ChangeRow({ row, styles }: { row: ChangeRowData; styles: Styles }) {
  const spoken = `${row.field}${row.from !== undefined ? `, from ${row.from}` : ""}${row.to !== undefined ? `${row.from !== undefined ? " to" : ","} ${row.to}` : ""}`;
  return (
    <View style={styles.changeRow} accessible accessibilityLabel={spoken}>
      <Text style={styles.field}>{row.field}</Text>
      <Text style={styles.values}>
        {row.from !== undefined ? <Text style={styles.from}>{row.from}</Text> : null}
        {row.from !== undefined && row.to !== undefined ? <Text style={styles.arrow}>{"  →  "}</Text> : null}
        {row.to !== undefined ? <Text style={styles.to}>{row.to}</Text> : null}
      </Text>
    </View>
  );
}

function Block({ block, t, styles }: { block: ToolBlock; t: Theme; styles: Styles }): ReactNode {
  switch (block.type) {
    case "groups":
      return (
        <View style={styles.groups}>
          {block.groups.map((g, i) => (
            <View key={`${g.title}-${i}`}>
              <Text style={styles.groupTitle} numberOfLines={2}>{g.title}</Text>
              <View style={styles.groupRows}><Rows rows={g.rows} styles={styles} /></View>
            </View>
          ))}
        </View>
      );
    case "rows":
      return <Rows rows={block.rows} styles={styles} />;
    case "diff":
      return (
        <View style={styles.diff}>
          {block.rows.map((row, i) => (
            <View
              key={i}
              style={[styles.diffRow, { backgroundColor: withAlpha(row.sign === "+" ? t.success : t.danger, 0.12) }]}
              accessible
              accessibilityLabel={`${row.sign === "+" ? "Added" : "Removed"}: ${row.text || "blank line"}`}
            >
              <Text style={[styles.diffSign, { color: row.sign === "+" ? t.success : t.danger }]} importantForAccessibility="no">{row.sign}</Text>
              <Text style={[styles.diffText, row.sign === "-" && { color: t.textSecondary }]}>{row.text || " "}</Text>
            </View>
          ))}
          {block.hidden > 0 ? <Text style={styles.diffMore}>{`+${block.hidden} more lines`}</Text> : null}
        </View>
      );
    case "text":
      return <Text style={block.muted ? styles.muted : styles.text}>{block.text}</Text>;
    case "caption":
      return <Text style={styles.captionText}>{block.text}</Text>;
    case "heading":
      return (
        <Text style={styles.heading}>
          {block.text}
          {block.note ? <Text style={styles.captionText}>{`  ${block.note}`}</Text> : null}
        </Text>
      );
    case "chips":
      return (
        <View style={styles.chips}>
          {block.items.map((item, i) => (
            <View key={`${item}-${i}`} style={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{item}</Text></View>
          ))}
        </View>
      );
    case "hits":
      return (
        <View style={styles.rows}>
          {block.items.map((h, i) => (
            <View key={`${h.title}-${i}`} style={styles.listRow}>
              <Text style={styles.listName} numberOfLines={1}>{h.title}</Text>
              {h.hint ? <Text style={styles.listTail} numberOfLines={1}>{h.hint}</Text> : null}
            </View>
          ))}
          {block.more > 0 ? <Text style={styles.captionText}>{`+${block.more} more`}</Text> : null}
        </View>
      );
    case "list":
      return (
        <View style={styles.rows}>
          {block.items.map((p, i) => (
            <View key={`${p.name}-${i}`} style={styles.listRow}>
              <Text style={styles.listName} numberOfLines={1}>
                {p.name}
                {p.meta ? <Text style={styles.listTail}>{`  ${p.meta}`}</Text> : null}
              </Text>
              {p.tail ? <Text style={styles.listTail} numberOfLines={1}>{p.tail}</Text> : null}
            </View>
          ))}
          {block.more > 0 ? <Text style={styles.captionText}>{`+${block.more} more`}</Text> : null}
        </View>
      );
    case "sentence":
      return (
        <Text style={styles.text}>
          {block.parts.map((p, i) => <Text key={i} style={p.strong ? styles.strong : undefined}>{p.text}</Text>)}
        </Text>
      );
  }
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      alignSelf: "flex-start",
      maxWidth: "100%",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    cardOpen: { width: "100%" },
    header: { flexDirection: "row", alignItems: "center", gap: 8 },
    headerMain: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28 },
    label: { ...typeScale.caption, color: t.textSecondary, flexShrink: 1, maxWidth: 240 },
    open: { paddingHorizontal: 8, paddingVertical: 2 },
    openText: { ...typeScale.label, color: t.accent },
    body: { gap: 6, paddingTop: 6, paddingBottom: 6 },
    panel: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
    panelLabel: { ...typeScale.micro, color: t.textTertiary },
    rows: { gap: 4 },
    changeRow: { flexDirection: "row", alignItems: "baseline", gap: 10 },
    field: { ...typeScale.caption, color: t.textTertiary, width: 72 },
    values: { ...typeScale.caption, color: t.textSecondary, flex: 1, fontVariant: ["tabular-nums"] },
    from: { color: t.textTertiary, textDecorationLine: "line-through" },
    arrow: { color: t.textTertiary },
    to: { color: t.textPrimary, fontWeight: "600" },
    groups: { gap: 8 },
    groupTitle: { ...typeScale.label, color: t.textPrimary },
    groupRows: { marginTop: 3, borderLeftWidth: 1, borderLeftColor: t.border, paddingLeft: 8 },
    diff: { borderWidth: 1, borderColor: t.border, borderRadius: 6, overflow: "hidden" },
    diffRow: { flexDirection: "row", gap: 6, paddingHorizontal: 6, paddingVertical: 2 },
    diffSign: { ...typeScale.micro, fontFamily: "Menlo", width: 8 },
    diffText: { ...typeScale.micro, fontFamily: "Menlo", color: t.textPrimary, flex: 1, fontVariant: ["tabular-nums"] },
    diffMore: { ...typeScale.micro, color: t.textTertiary, paddingHorizontal: 6, paddingVertical: 2 },
    text: { ...typeScale.caption, color: t.textSecondary },
    muted: { ...typeScale.caption, color: t.textTertiary },
    strong: { color: t.textPrimary },
    captionText: { ...typeScale.micro, color: t.textTertiary },
    heading: { ...typeScale.label, color: t.textPrimary },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
    chip: { maxWidth: "100%", backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    chipText: { ...typeScale.micro, color: t.textSecondary },
    listRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
    listName: { ...typeScale.caption, color: t.textPrimary, flexShrink: 1 },
    listTail: { ...typeScale.micro, color: t.textTertiary, flexShrink: 0 },
    rawToggle: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28 },
    rawLabel: { ...typeScale.micro, color: t.textTertiary },
    payload: { marginTop: 4, borderWidth: 1, borderColor: t.border, borderRadius: 6, padding: 6, gap: 4 },
    payloadLabel: { ...typeScale.micro, color: t.textTertiary },
    payloadText: { ...typeScale.micro, color: t.textSecondary },
  });
}
