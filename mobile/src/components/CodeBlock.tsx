import { useMemo, useState, type ReactNode } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { createLowlight, common } from "lowlight";
import * as Clipboard from "expo-clipboard";
import { Copy, Check } from "lucide-react-native";
import { useTheme, useIsDark, type as typeScale, type Theme } from "@/theme";
import { buildHljsPalette } from "@cairn/shared/notes/syntax-palette";

// Lazily construct the lowlight instance on first use rather than at module
// import. Registering the ~37 `common` grammars is a non-trivial startup cost;
// deferring it until a code block is actually rendered keeps app launch and the
// first notes/chat render lighter (Metro bundles the grammars either way, so
// there's no code-split win as on desktop — this defers evaluation only).
type Lowlight = ReturnType<typeof createLowlight>;
let _lowlight: Lowlight | null = null;
function getLowlight(): Lowlight {
  if (!_lowlight) _lowlight = createLowlight(common);
  return _lowlight;
}

const MONO = "Menlo";

const DARK_PALETTE = buildHljsPalette("dark");
const LIGHT_PALETTE = buildHljsPalette("light");

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

/**
 * Syntax-highlighted code block — the mobile analogue of the desktop
 * CodeBlock.tsx. Tokenises with lowlight (highlight.js grammars, pure JS, no
 * native code) and colours each token from the shared SYNTAX_COLORS palette so
 * dark/light output matches the desktop exactly. Renders a header bar with the
 * language label and a copy button, then the code in a horizontal scroller.
 */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const t = useTheme();
  const isDark = useIsDark();
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  const styles = useMemo(() => makeStyles(t), [t]);
  const [copied, setCopied] = useState(false);

  const lang = (language || "").toLowerCase().trim();

  // Tokenise once per code/lang. Unknown languages fall back to plain text.
  const tree = useMemo(() => {
    const source = code.replace(/\n$/, "");
    try {
      const ll = getLowlight();
      if (lang && ll.registered(lang)) {
        return ll.highlight(lang, source).children as HastNode[];
      }
    } catch {
      // fall through to plain text
    }
    return [{ type: "text", value: source }] as HastNode[];
  }, [code, lang]);

  const onCopy = async () => {
    await Clipboard.setStringAsync(code.replace(/\n$/, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.lang}>{lang || "text"}</Text>
        <Pressable onPress={onCopy} hitSlop={8} style={styles.copyBtn}>
          {copied ? <Check size={13} color={t.success} /> : <Copy size={13} color={t.textTertiary} />}
          <Text style={[styles.copyText, copied && { color: t.success }]}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text style={styles.code}>
          {tree.map((node, i) => (
            <TokenNode key={i} node={node} palette={palette} baseColor={t.textPrimary} />
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

function TokenNode({
  node,
  palette,
  baseColor,
}: {
  node: HastNode;
  palette: Record<string, string>;
  baseColor: string;
}): ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const classes = node.properties?.className ?? [];
    const color = classes.map((c) => palette[c]).find(Boolean);
    const children = node.children?.map((child, i) => (
      <TokenNode key={i} node={child} palette={palette} baseColor={baseColor} />
    ));
    return <Text style={color ? { color } : undefined}>{children}</Text>;
  }
  return null;
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    wrap: {
      backgroundColor: t.surface2,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: t.border,
      marginBottom: 12,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: t.surface3,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    lang: { fontSize: 11, color: t.textTertiary, fontFamily: MONO, textTransform: "lowercase" },
    copyBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
    copyText: { ...typeScale.micro, fontWeight: "600", color: t.textTertiary },
    codeScroll: { padding: 12 },
    code: { color: t.textPrimary, fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  });
}
