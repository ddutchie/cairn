import { useMemo } from "react";
import { View, StyleSheet } from "react-native";
import { SvgXml } from "react-native-svg";
import { Server, Plug } from "lucide-react-native";
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
  const styles = useMemo(() => makeStyles(size), [size]);
  const tint = color || t.textSecondary;

  if (iconSvg && looksSafeSvg(iconSvg)) {
    return (
      <View style={styles.wrap}>
        <SvgXml xml={iconSvg} width={size} height={size} color={tint} />
      </View>
    );
  }
  const Glyph = kind === "service" ? Plug : Server;
  return (
    <View style={styles.wrap}>
      <Glyph size={size} color={tint} />
    </View>
  );
}

function makeStyles(size: number) {
  return StyleSheet.create({
    wrap: { width: size, height: size, alignItems: "center", justifyContent: "center" },
  });
}
