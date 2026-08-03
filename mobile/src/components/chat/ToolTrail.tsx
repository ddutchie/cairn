import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, Linking, ActivityIndicator } from "react-native";
import { CheckCircle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react-native";
import { useRouter } from "expo-router";
import { prettifyToolLabel } from "@cairn/shared/ui/constants";
import { extractExternalRefs, isHttpUrl, type ExternalRef } from "@cairn/shared/chat/external-ref";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import type { ToolCall } from "@/db/chat-store";
import { ConnectorLogo } from "@/components/ConnectorLogo";
import { listInstalledMcpServers } from "@/chat/mcp-store";
import { listInstalledServices } from "@/chat/services";
import { getCachedManifest } from "@/chat/registry";
import { prettyToolOutput, safeToolOutput } from "@/chat/tool-output";

type Connector = { name: string; kind: "mcp" | "service"; iconSvg?: string; brandColor?: string };

/**
 * The vertical trail of tool-call chips shown above an assistant bubble. A chip
 * whose tool created/touched a note or card is tappable and opens it by id (the
 * reliable, collision-proof path); read-only tools render as a plain chip.
 */
export function ToolTrail({ tools }: { tools: ToolCall[] }) {
  const t = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(t), [t]);
  const connectors: Record<string, Connector> = {};
  const manifest = getCachedManifest();
  for (const server of listInstalledMcpServers()) {
    const entry = manifest?.mcpServers.find((candidate) => candidate.id === server.id || candidate.definition.name === server.name);
    connectors[`mcp__${server.id}__`] = {
      name: server.name,
      kind: "mcp",
      iconSvg: server.iconSvg ?? entry?.iconSvg,
      brandColor: server.brandColor ?? entry?.brandColor,
    };
  }
  for (const service of listInstalledServices()) {
    const entry = manifest?.services.find((candidate) => candidate.id === service.id || candidate.definition.name === service.name);
    connectors[`svc__${service.id}__`] = {
      name: service.name,
      kind: "service",
      iconSvg: service.iconSvg ?? entry?.iconSvg,
      brandColor: service.brandColor ?? entry?.brandColor,
    };
  }
  return (
    <View style={styles.toolTrail}>
      {tools.map((tt, i) => {
        const label = prettifyToolLabel(tt.tool, { prettifyBare: true });
        const connector = Object.entries(connectors).find(([prefix]) => tt.tool.startsWith(prefix))?.[1];
        if (tt.running) {
          // Tool is executing — show a spinner chip until its result arrives.
          return (
            <View key={i} style={styles.toolChip}>
              <ActivityIndicator size="small" color={t.textSecondary} style={styles.spinner} />
              <Text style={styles.toolChipText}>{label}…</Text>
            </View>
          );
        }
        if (tt.ref) {
          return (
            <Pressable
              key={i}
              style={styles.toolChip}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Open ${label}`}
              onPress={() => {
                haptics.impact();
                router.push(tt.ref!.kind === "card" ? `/card/${tt.ref!.id}` : `/note/${tt.ref!.id}`);
              }}
            >
              <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
              <Text style={[styles.toolChipText, styles.toolChipLink]}>{label}</Text>
              <ChevronRight size={10} color={t.accent} />
            </Pressable>
          );
        }
        if (connector) {
          return <MobileConnectorCard key={i} tool={tt} label={label} connector={connector} t={t} styles={styles} />;
        }
        if (tt.externalRef && isHttpUrl(tt.externalRef.url)) {
          const er = tt.externalRef;
          const chipLabel = er.title || hostOf(er.url);
          return (
            <Pressable
              key={i}
              style={styles.toolChip}
              hitSlop={6}
              accessibilityRole="link"
              accessibilityLabel={`Open ${chipLabel}`}
              onPress={() => {
                haptics.impact();
                void Linking.openURL(er.url);
              }}
            >
              <ExternalLink size={10} color={t.accent} />
              <Text style={[styles.toolChipText, styles.toolChipLink]} numberOfLines={1}>{chipLabel}</Text>
              <ChevronRight size={10} color={t.accent} />
            </Pressable>
          );
        }
        return (
          <View key={i} style={styles.toolChip}>
            <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
            <Text style={styles.toolChipText}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

function MobileConnectorCard({ tool, label, connector, t, styles }: { tool: ToolCall; label: string; connector: Connector; t: Theme; styles: ReturnType<typeof makeStyles> }) {
  const [expanded, setExpanded] = useState(false);
  const args = tool.args ? safeToolOutput(tool.args) : undefined;
  const output = prettyToolOutput(safeToolOutput(tool.output));
  const refs = collectExternalRefs(tool.externalRef, extractExternalRefs(output, 20));
  const [showAllRefs, setShowAllRefs] = useState(false);
  const visibleRefs = showAllRefs ? refs : refs.slice(0, 3);
  return (
    <View style={[styles.connectorCard, { borderLeftColor: connector.brandColor || t.accent }] }>
      <Pressable
        style={styles.connectorHeaderButton}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${connector.name} tool call`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <ConnectorLogo iconSvg={connector.iconSvg} kind={connector.kind} color={connector.brandColor} size={22} />
        <Text style={styles.connectorName} numberOfLines={1}>{connector.name}</Text>
        <Text style={styles.connectorVia}>via {connector.kind === "mcp" ? "MCP" : "HTTP service"}</Text>
        {expanded ? <ChevronDown size={12} color={t.textTertiary} /> : <ChevronRight size={12} color={t.textTertiary} />}
      </Pressable>
      {expanded ? (
        <View style={styles.connectorDetails}>
          <Text style={styles.toolChipText}>{label}</Text>
          <Text style={styles.connectorToolName}>Tool: {label}</Text>
          {args ? <MobileToolPayload label="Arguments" value={args} styles={styles} /> : null}
          {output ? <MobileToolPayload label="Result" value={output} styles={styles} /> : null}
          {visibleRefs.length > 0 ? (
            <View style={styles.externalRefs}>
              {visibleRefs.map((ref) => <MobileExternalRef key={ref.url} refData={ref} toolName={tool.tool} styles={styles} />)}
              {refs.length > 3 ? (
                <Pressable onPress={() => setShowAllRefs((value) => !value)}>
                  <Text style={styles.showMore}>{showAllRefs ? "Show less" : `Show ${refs.length - 3} more`}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function collectExternalRefs(primary: ExternalRef | undefined, extracted: ExternalRef[]): ExternalRef[] {
  const refs = primary ? [primary, ...extracted] : extracted;
  return refs.filter((ref, index) => refs.findIndex((candidate) => candidate.url === ref.url) === index);
}

function MobileExternalRef({ refData, toolName, styles }: { refData: ExternalRef; toolName: string; styles: ReturnType<typeof makeStyles> }) {
  const label = refData.title || hostOf(refData.url);
  return (
    <Pressable
      style={styles.externalRef}
      accessibilityRole="link"
      accessibilityLabel={`Open ${label}`}
      onPress={() => {
        haptics.impact();
        if (isHttpUrl(refData.url)) void Linking.openURL(refData.url);
      }}
    >
      <ExternalLink size={10} color={styles.showMore.color} />
      <View style={styles.externalRefText}>
        <Text style={styles.externalRefTitle} numberOfLines={1}>{label}</Text>
        <Text style={styles.externalRefSubtitle} numberOfLines={1}>{refData.title ? hostOf(refData.url) : prettifyToolLabel(toolName)}</Text>
      </View>
    </Pressable>
  );
}

function MobileToolPayload({ label, value, styles }: { label: string; value: string; styles: ReturnType<typeof makeStyles> }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  return (
    <View style={styles.payload}>
      <Text style={styles.payloadLabel}>{label}</Text>
      {parsed !== undefined ? <MobileJsonTree value={parsed} styles={styles} /> : <Text style={styles.connectorOutput}>{value}</Text>}
    </View>
  );
}

function MobileJsonTree({ value, styles, depth = 0 }: { value: unknown; styles: ReturnType<typeof makeStyles>; depth?: number }) {
  if (value === null) return <Text style={styles.jsonValue}>null</Text>;
  if (typeof value !== "object") return <Text style={styles.jsonValue}>{typeof value === "string" ? `"${value}"` : String(value)}</Text>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  return (
    <View style={styles.jsonTree}>
      {entries.map(([key, child]) => {
        const nested = child !== null && typeof child === "object";
        return nested ? (
          <MobileJsonBranch key={key} label={key} value={child} styles={styles} depth={depth} />
        ) : (
          <View key={key} style={styles.jsonRow}>
            <Text style={styles.jsonKey}>{key}</Text>
            <MobileJsonTree value={child} styles={styles} depth={depth + 1} />
          </View>
        );
      })}
    </View>
  );
}

function MobileJsonBranch({ label, value, styles, depth }: { label: string; value: object; styles: ReturnType<typeof makeStyles>; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  return (
    <View style={styles.jsonBranch}>
      <Pressable style={styles.jsonBranchButton} onPress={() => setExpanded((current) => !current)} accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label}`} accessibilityState={{ expanded }}>
        {expanded ? <ChevronDown size={11} color={styles.jsonChevron.color} /> : <ChevronRight size={11} color={styles.jsonChevron.color} />}
        <Text style={styles.jsonKey}>{label}</Text>
        <Text style={styles.jsonType}>{Array.isArray(value) ? `[${size}]` : `{${size}}`}</Text>
      </Pressable>
      {expanded ? <MobileJsonTree value={value} styles={styles} depth={depth + 1} /> : null}
    </View>
  );
}

/** Best-effort friendly host label for an external URL (e.g. "github.com"). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    toolTrail: { flexDirection: "column", gap: 4, alignSelf: "flex-start" },
    toolChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    connectorCard: {
      flexDirection: "column",
      alignSelf: "flex-start",
      width: "100%",
      backgroundColor: t.surface,
      borderWidth: 1,
      borderLeftWidth: 3,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    connectorHeaderButton: { flexDirection: "row", alignItems: "center", gap: 8, width: "100%" },
    connectorDetails: { borderTopWidth: 1, borderTopColor: t.border, marginTop: 8, paddingTop: 6, gap: 3 },
    connectorName: { ...typeScale.caption, color: t.textPrimary, fontWeight: "600", flexShrink: 1 },
    connectorVia: { ...typeScale.micro, color: t.textTertiary },
    connectorToolName: { ...typeScale.micro, color: t.textTertiary },
    connectorDetailsText: { ...typeScale.micro, color: t.textTertiary, fontFamily: "monospace" },
    connectorOutput: { ...typeScale.micro, color: t.textTertiary },
    externalRefs: { gap: 4, alignItems: "flex-start" },
    externalRef: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, maxWidth: "100%" },
    externalRefText: { flexShrink: 1 },
    externalRefTitle: { ...typeScale.caption, color: t.textPrimary, fontWeight: "600" },
    externalRefSubtitle: { ...typeScale.micro, color: t.textTertiary },
    showMore: { ...typeScale.micro, color: t.accent },
    payload: { marginTop: 4, borderWidth: 1, borderColor: t.border, borderRadius: 6, padding: 6, gap: 4 },
    payloadLabel: { ...typeScale.micro, color: t.textTertiary, fontWeight: "600", textTransform: "uppercase" },
    jsonTree: { gap: 2 },
    jsonBranch: { borderLeftWidth: 1, borderLeftColor: t.border, paddingLeft: 5 },
    jsonBranchButton: { flexDirection: "row", alignItems: "center", gap: 3 },
    jsonRow: { flexDirection: "row", gap: 8, borderLeftWidth: 1, borderLeftColor: t.border, paddingLeft: 5 },
    jsonKey: { ...typeScale.micro, color: t.textTertiary, flexShrink: 1 },
    jsonValue: { ...typeScale.micro, color: t.textSecondary, flexShrink: 1 },
    jsonType: { ...typeScale.micro, color: t.textTertiary },
    jsonChevron: { color: t.textTertiary },
    toolChipText: { ...typeScale.caption, color: t.textSecondary },
    toolChipLink: { color: t.accent, maxWidth: 220 },
    spinner: { transform: [{ scale: 0.7 }], width: 10, height: 10 },
  });
}
