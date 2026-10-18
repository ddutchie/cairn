import { useMemo, useState, type ReactNode } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Circle, GitBranch, Hexagon, Type, ChevronDown, Network, Maximize2 } from "lucide-react-native";
import { useTheme, withAlpha, type as typeScale, iconSize, type Theme } from "@/theme";
import { SearchField } from "@/components/SearchField";
import { nodeTypeColor } from "@/graph/colors";
import { ALL_NODE_TYPES } from "@/graph/filter";
import type { GraphMode } from "@/graph/useGraphControls";
import type { GraphNodeType } from "@/db/queries";
import type { LabelMode } from "@cairn/shared/ui/graph";

const LABEL_MODES: LabelMode[] = ["smart", "all", "minimal"];

export interface GraphChromeProps {
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  /** Show the in-body Force/Radial segment (hidden when the native toolbar drives it). */
  showModeToggle: boolean;
  labelMode: LabelMode;
  onLabelModeChange: (mode: LabelMode) => void;
  /** Show the in-body labels pill (hidden when the native toolbar drives it). */
  showLabelPill: boolean;
  showHulls: boolean;
  onToggleHulls: () => void;
  showSemantic: boolean;
  onToggleSemantic?: () => void;
  semanticAvailable: boolean;
  semanticLoading: boolean;
  search: string;
  onSearchChange: (q: string) => void;
  activeTypes: ReadonlySet<GraphNodeType>;
  onToggleType: (type: GraphNodeType) => void;
  nodeCount: number;
  edgeCount: number;
  onFit: () => void;
  /** The graph canvas (WebView or Skia) — fills the area under the toolbar rows. */
  children: ReactNode;
}

/**
 * Toolbar rows, label dropdown, legend and zoom-to-fit around a graph canvas.
 * Renderer-agnostic so the Skia and WebView graphs share identical chrome.
 */
export function GraphChrome({
  mode,
  onModeChange: setMode,
  showModeToggle,
  labelMode,
  onLabelModeChange: setLabelMode,
  showLabelPill,
  showHulls,
  onToggleHulls,
  showSemantic,
  onToggleSemantic,
  semanticAvailable,
  semanticLoading,
  search,
  onSearchChange,
  activeTypes,
  onToggleType: toggleType,
  nodeCount,
  edgeCount,
  onFit,
  children,
}: GraphChromeProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelAnchorX, setLabelAnchorX] = useState(116);

  return (
    <View style={[styles.root, { backgroundColor: t.background }]}>
      {/* ── Header line 1: layout toggle · label dropdown · hulls ── */}
      <View style={styles.toolbarRow}>
        {/* Layout mode segmented toggle (Force / Radial). Hidden when the parent
            (native header toolbar) drives the mode. */}
        {showModeToggle ? (
          <View style={styles.segment}>
            {([
              { key: "force" as const, Icon: Circle, label: "Force" },
              { key: "radial" as const, Icon: GitBranch, label: "Radial" },
            ]).map(({ key, Icon, label }, idx) => {
              const active = mode === key;
              return (
                <View key={key} style={styles.segmentPart}>
                  {idx > 0 ? <View style={styles.segmentDivider} /> : null}
                  <Pressable
                    onPress={() => setMode(key)}
                    style={[styles.segmentBtn, active && { backgroundColor: t.accentDim }]}
                  >
                    <Icon size={iconSize.control} color={active ? t.accent : t.textTertiary} />
                    {active ? (
                      <Text style={[styles.segmentLabel, { color: t.accent }]}>{label}</Text>
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* Label mode dropdown — force only (radial drills in, no label modes).
            Hidden when the parent (native left toolbar menu) drives labelMode. */}
        {mode === "force" && showLabelPill ? (
          <Pressable
            onLayout={(e) => setLabelAnchorX(e.nativeEvent.layout.x)}
            onPress={() => setLabelOpen((v) => !v)}
            style={[styles.pillBtn, { borderColor: t.border }]}
          >
            <Type size={iconSize.control} color={t.textSecondary} />
            <Text style={styles.pillLabel}>{labelMode} labels</Text>
            <ChevronDown size={iconSize.hint} color={t.textSecondary} />
          </Pressable>
        ) : null}

        {/* Semantic-links toggle — force only, left of Hulls, when available.
            Shows a spinner while the on-device semantic pass is computing. */}
        {mode === "force" && semanticAvailable && onToggleSemantic ? (
          <Pressable
            onPress={onToggleSemantic}
            disabled={semanticLoading}
            style={[
              styles.pillBtn,
              showSemantic
                ? { borderColor: "transparent", backgroundColor: t.accentDim }
                : { borderColor: t.border },
            ]}
          >
            {semanticLoading ? (
              <ActivityIndicator size="small" color={showSemantic ? t.accent : t.textTertiary} style={styles.pillSpinner} />
            ) : (
              <Network size={iconSize.control} color={showSemantic ? t.accent : t.textTertiary} />
            )}
            <Text style={[styles.pillLabel, { color: showSemantic ? t.accent : t.textTertiary }]}>
              Semantic
            </Text>
          </Pressable>
        ) : null}

        {/* Cluster hulls toggle — force only */}
        {mode === "force" ? (
          <Pressable
            onPress={onToggleHulls}
            style={[
              styles.pillBtn,
              showHulls
                ? { borderColor: "transparent", backgroundColor: t.accentDim }
                : { borderColor: t.border },
            ]}
          >
            <Hexagon size={iconSize.control} color={showHulls ? t.accent : t.textTertiary} />
            <Text style={[styles.pillLabel, { color: showHulls ? t.accent : t.textTertiary }]}>
              Hulls
            </Text>
          </Pressable>
        ) : null}

        <View style={{ flex: 1 }} />
        <Text style={styles.stats}>
          {nodeCount} · {edgeCount}
        </Text>
      </View>

      {/* ── Header line 2: search · node-type toggles ── */}
      <View style={[styles.toolbarRow, styles.toolbarRow2]}>
        <SearchField value={search} onChangeText={onSearchChange} containerStyle={{ flex: 1 }} />
        <View style={styles.typeToggles}>
          {ALL_NODE_TYPES.map((type) => {
            const active = activeTypes.has(type);
            const color = nodeTypeColor(type, t);
            return (
              <Pressable
                key={type}
                onPress={() => toggleType(type)}
                style={[
                  styles.typeChip,
                  {
                    backgroundColor: active ? withAlpha(color, 0.16) : "transparent",
                    borderColor: active ? withAlpha(color, 0.4) : t.border,
                  },
                ]}
              >
                <View style={[styles.typeDot, { backgroundColor: active ? color : t.textTertiary }]} />
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Label-mode dropdown menu (overlay) — only when the in-body pill is
          shown (i.e. the parent isn't driving labelMode via the native menu). */}
      {labelOpen && mode === "force" && showLabelPill ? (
        <>
          <Pressable style={styles.dropdownBackdrop} onPress={() => setLabelOpen(false)} />
          <View style={[styles.dropdownMenu, { left: labelAnchorX }]}>
            {LABEL_MODES.map((m) => {
              const active = labelMode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => {
                    setLabelMode(m);
                    setLabelOpen(false);
                  }}
                  style={[styles.dropdownItem, active && { backgroundColor: t.accentDim }]}
                >
                  <Text
                    style={[
                      styles.dropdownItemText,
                      { color: active ? t.accent : t.textSecondary, fontWeight: active ? "600" : "400" },
                    ]}
                  >
                    {m}
                  </Text>
                  {active ? <View style={[styles.dropdownDot, { backgroundColor: t.accent }]} /> : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}


      <View style={styles.canvasWrap}>
        {children}

        {/* Legend + zoom-to-fit — bottom row. Keys are left-aligned, the fit
            button is right-aligned in the same row. Offset by the safe-area
            inset so it clears the home indicator / tab bar. Force only. */}
        {mode === "force" ? (
          <View style={[styles.bottomRow, { bottom: 16 + insets.bottom }]} pointerEvents="box-none">
            <View style={styles.legend}>
              {ALL_NODE_TYPES.filter((type) => activeTypes.has(type)).map((type) => (
                <View key={type} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: nodeTypeColor(type, t) }]} />
                  <Text style={styles.legendLabel} numberOfLines={1}>{type}</Text>
                </View>
              ))}
            </View>
            <Pressable
              onPress={onFit}
              style={styles.fitBtn}
              accessibilityLabel="Zoom to fit"
              hitSlop={8}
            >
              <Maximize2 size={iconSize.control} color={t.textSecondary} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1 },
    toolbarRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: t.surface,
    },
    toolbarRow2: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      paddingTop: 0,
    },
    // Layout segmented toggle
    segment: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      overflow: "hidden",
    },
    segmentPart: { flexDirection: "row", alignItems: "center" },
    segmentDivider: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: t.border },
    segmentBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    segmentLabel: { ...typeScale.control },
    // Pill buttons (label dropdown, hulls)
    pillBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 8,
      borderWidth: 1,
    },
    pillLabel: { ...typeScale.control, fontWeight: "500", color: t.textSecondary, textTransform: "capitalize" },
    // Constrain the spinner to the icon footprint so the pill doesn't resize
    // when it swaps between the Network icon and the ActivityIndicator.
    pillSpinner: { width: iconSize.control, height: iconSize.control },
    stats: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    // Node-type toggles (line 2)
    typeToggles: { flexDirection: "row", alignItems: "center", gap: 6 },
    typeChip: {
      width: 26,
      height: 26,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 13,
      borderWidth: 1,
    },
    typeDot: { width: 9, height: 9, borderRadius: 4.5 },
    // Label-mode dropdown
    dropdownBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
    dropdownMenu: {
      position: "absolute",
      top: 44,
      width: 150,
      zIndex: 11,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
      paddingVertical: 4,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    dropdownItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    dropdownItemText: { ...typeScale.caption, fontWeight: "400", textTransform: "capitalize" },
    dropdownDot: { width: 6, height: 6, borderRadius: 3 },
    // Canvas + legend
    canvasWrap: { flex: 1 },
    // Bottom overlay row: legend (left) + zoom-to-fit (right).
    bottomRow: {
      position: "absolute",
      left: 16,
      right: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    legend: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: withAlpha(t.surface, 0.9),
      flexShrink: 1,
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
    legendDot: { width: 10, height: 10, borderRadius: 5 },
    legendLabel: { fontSize: 11, color: t.textTertiary, textTransform: "capitalize" },
    fitBtn: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: withAlpha(t.surface, 0.9),
      flexShrink: 0,
    },
  });
}
