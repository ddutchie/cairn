import { useMemo } from "react";
import { View, Text, Pressable, StyleSheet, Linking, ActivityIndicator } from "react-native";
import { CheckCircle, ChevronRight, ExternalLink } from "lucide-react-native";
import { useRouter } from "expo-router";
import { prettifyToolLabel } from "@cairn/shared/ui/constants";
import { isHttpUrl } from "@cairn/shared/chat/external-ref";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import type { ToolCall } from "@/db/chat-store";
import { ConnectorLogo } from "@/components/ConnectorLogo";
import { listInstalledMcpServers } from "@/chat/mcp-store";
import { listInstalledServices } from "@/chat/services";
import { getCachedManifest } from "@/chat/registry";

/**
 * The vertical trail of tool-call chips shown above an assistant bubble. A chip
 * whose tool created/touched a note or card is tappable and opens it by id (the
 * reliable, collision-proof path); read-only tools render as a plain chip.
 */
export function ToolTrail({ tools }: { tools: ToolCall[] }) {
  const t = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(t), [t]);
  const connectors: Record<string, { name: string; kind: "mcp" | "service"; iconSvg?: string; brandColor?: string }> = {};
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
          return (
            <View key={i} style={[styles.connectorCard, { borderLeftColor: connector.brandColor || t.accent }]}>
              <ConnectorLogo iconSvg={connector.iconSvg} kind={connector.kind} color={connector.brandColor} size={22} />
              <View style={styles.connectorBody}>
                <View style={styles.connectorHeader}>
                  <Text style={styles.connectorName} numberOfLines={1}>{connector.name}</Text>
                  <Text style={styles.connectorVia}>via {connector.kind === "mcp" ? "MCP" : "HTTP service"}</Text>
                </View>
                <Text style={styles.toolChipText} numberOfLines={1}>{label}</Text>
                {tt.output ? <Text style={styles.connectorOutput} numberOfLines={2}>{tt.output}</Text> : null}
              </View>
            </View>
          );
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
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
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
    connectorBody: { flex: 1, minWidth: 0, gap: 3 },
    connectorHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    connectorName: { ...typeScale.caption, color: t.textPrimary, fontWeight: "600", flexShrink: 1 },
    connectorVia: { ...typeScale.micro, color: t.textTertiary },
    connectorOutput: { ...typeScale.micro, color: t.textTertiary },
    toolChipText: { ...typeScale.caption, color: t.textSecondary },
    toolChipLink: { color: t.accent, maxWidth: 220 },
    spinner: { transform: [{ scale: 0.7 }], width: 10, height: 10 },
  });
}
