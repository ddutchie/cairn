import { useMemo } from "react";
import { View, StyleSheet } from "react-native";
import { Path, Svg, SvgXml } from "react-native-svg";
import { useTheme } from "@/theme";

/**
 * ConnectorLogo (mobile) — renders a community-registry connector's brand logo,
 * mirroring the desktop component (src/components/settings/tools/ConnectorLogo).
 *
 * The logo arrives as inline SVG markup (`iconSvg`) already compiled + allowlist-
 * sanitized by the cairn-community CI. We still run the same cheap defense-in-
 * depth guard (`looksSafeSvg`) before rendering it via react-native-svg's SvgXml,
 * so a compromised manifest can't inject anything unexpected. When `iconSvg` is
 * absent or fails the guard we fall back to a generic glyph: a server mark for
 * MCP servers, a plug for HTTP services (matching desktop's fallbacks).
 */
export interface ConnectorLogoProps {
  iconSvg?: string;
  kind?: "mcp" | "service";
  size?: number;
  /** Brand colour from the manifest entry; tints the fallback glyph + wrapper. */
  color?: string;
}

/**
 * Defense-in-depth (matches desktop looksSafeSvg): accept only a plain <svg>
 * element with none of the dangerous constructs. Anything else → fallback glyph.
 */
function looksSafeSvg(svg: string): boolean {
  const s = svg.trim();
  if (/^<svg[\s>]/i.test(s) === false || !/<\/svg>\s*$/i.test(s)) return false;
  if (/<script|<foreignobject|<iframe|<image|<use\b/i.test(s)) return false;
  if (/(?:^|[\s"'/])on\w+\s*=/i.test(s)) return false;
  if (/href\s*=|javascript:|data:(?!image\/)/i.test(s)) return false;
  if (/url\(\s*(?!['"]?#)/i.test(s)) return false;
  return true;
}

export function ConnectorLogo({ iconSvg, kind = "mcp", size = 22, color }: ConnectorLogoProps) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(size, t), [size, t]);
  const tint = color || t.textSecondary;

  if (iconSvg && looksSafeSvg(iconSvg)) {
    return (
      <View style={styles.wrap}>
        <SvgXml xml={iconSvg} width={size} height={size} color={tint} />
      </View>
    );
  }
  return (
    <View style={[styles.wrap, styles.fallback]}>
      <Svg width="100%" height="100%" viewBox="0 0 24 24">
        {kind === "service" ? (
          <Path
            fill="none"
            stroke={t.textSecondary}
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 7V4m6 3V4M7.5 7h9v4a4.5 4.5 0 0 1-9 0V7Zm4.5 9v4"
          />
        ) : (
          <Path
            fill={t.textSecondary}
            d="M13.85 2a4.16 4.16 0 0 0-2.95 1.22L2.46 11.66a.84.84 0 0 0 1.18 1.18l8.44-8.44a2.49 2.49 0 0 1 3.54 3.54l-6.02 6.02-.1.1a.84.84 0 0 0 1.18 1.19l6.12-6.12a2.49 2.49 0 0 1 3.54 0 2.49 2.49 0 0 1 0 3.54l-8.53 8.53a.84.84 0 0 0 0 1.18l.53.53a.84.84 0 0 0 1.18 0l8.53-8.53a4.17 4.17 0 0 0-5.9-5.9l-.06.06a4.16 4.16 0 0 0-6.9-4.5A4.16 4.16 0 0 0 13.85 2Z"
          />
        )}
      </Svg>
    </View>
  );
}

function makeStyles(size: number, t: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    wrap: { width: size, height: size, alignItems: "center", justifyContent: "center" },
    fallback: { padding: Math.round(size * 0.16), borderRadius: Math.max(4, Math.round(size * 0.22)), backgroundColor: t.surface2 },
  });
}
