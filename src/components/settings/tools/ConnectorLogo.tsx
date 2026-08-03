/**
 * ConnectorLogo — renders a community-registry connector's brand logo.
 *
 * The logo arrives as inline SVG markup (`iconSvg`) that was compiled AND
 * allowlist-sanitized by the cairn-community CI (scripts/svg-sanitize.mjs) — no
 * scripts, event handlers, external refs, or <foreignObject> can survive that
 * gate, so the markup is safe to inline. We still run a cheap defense-in-depth
 * check here (`looksSafeSvg`) before injecting, so a compromised manifest can
 * never turn into script execution in the renderer.
 *
 * No brand glyphs are bundled in the app anymore — new connectors get their
 * logo from the registry without an app release. When `iconSvg` is absent (or
 * fails the guard) we fall back to a generic glyph: the MCP mark for MCP
 * servers, a plug for HTTP services.
 */

import type { CSSProperties } from "react";
import { MCP_LOGO_PATHS } from "../../../../shared/branding/mcp-logo";

export interface ConnectorLogoProps {
  /** Inline SVG markup from the registry entry (already CI-sanitized). */
  iconSvg?: string;
  /** Which fallback glyph to use when there's no iconSvg. */
  kind?: "mcp" | "service";
  /** Pixel size of the square glyph. */
  size?: number;
  /** Brand colour from the manifest entry; tints the glyph via `color`. */
  color?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Defense-in-depth: the CI already rejects unsafe SVG, but the renderer must not
 * blindly trust a fetched string. Accept only a plain <svg> element with none of
 * the dangerous constructs. Anything else → fall back to a bundled glyph.
 */
function looksSafeSvg(svg: string): boolean {
  const s = svg.trim();
  if (/^<svg[\s>]/i.test(s) === false || !/<\/svg>\s*$/i.test(s)) return false;
  if (/<script|<foreignobject|<iframe|<image|<use\b/i.test(s)) return false;
  // Reject inline event handlers regardless of the preceding delimiter — after
  // whitespace, a closing quote, or another attribute char (e.g. `x"onload=`).
  if (/(?:^|[\s"'/])on\w+\s*=/i.test(s)) return false;
  if (/href\s*=|javascript:|data:(?!image\/)/i.test(s)) return false;
  if (/url\(\s*(?!['"]?#)/i.test(s)) return false; // url() to anything but a local #ref
  return true;
}

/**
 * Choose a legible foreground for the fixed LIGHT connector chip. The chip is
 * always light (`--connector-chip-bg`), so a real logo tinted with the entry's
 * `brandColor` must be dark enough to read on it. Accept only a valid hex colour
 * whose relative luminance is below a threshold; otherwise fall back to the fixed
 * dark chip foreground. This rejects near-white / invalid manifest brand colours
 * (which would render an invisible glyph) without trusting the value blindly.
 */
function chipForeground(brandColor?: string): string {
  const fallback = "var(--connector-chip-fg)";
  if (!brandColor) return fallback;
  const hex = brandColor.trim().replace(/^#/, "");
  const full =
    hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback; // invalid → safe dark fg
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Perceived luminance (0–255). Above ~0.72 is too light for the light chip.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.72 ? fallback : `#${full}`;
}

export function ConnectorLogo({
  iconSvg,
  kind = "mcp",
  size = 24,
  color,
  className,
  style,
}: ConnectorLogoProps) {
  const wrapStyle: CSSProperties = {
    width: size,
    height: size,
    color: color || "var(--text-secondary)",
    display: "inline-flex",
    ...style,
  };

  if (iconSvg && looksSafeSvg(iconSvg)) {
    // Real brand logo. Monochrome marks use `fill="currentColor"`, so we tint
    // with `brandColor`. A dark brand mark (e.g. charcoal) would vanish on the
    // dark theme's near-black card, so real logos sit on a FIXED light chip
    // (theme-independent) — like app-store icon tiles — guaranteeing contrast on
    // both themes. Sized via CSS so the SVG's intrinsic dimensions don't matter.
    return (
      <span
        className={className}
        style={{
          ...wrapStyle,
          boxSizing: "border-box",
          padding: Math.round(size * 0.16),
          borderRadius: Math.max(4, Math.round(size * 0.22)),
          background: "var(--connector-chip-bg)",
          color: chipForeground(color),
          alignItems: "center",
          justifyContent: "center",
        }}
        aria-hidden
        // Safe: SVG is sanitized by cairn-community CI + guarded by looksSafeSvg above.
        dangerouslySetInnerHTML={{
          // Inject sizing on the opening tag. Match every form looksSafeSvg
          // accepts: `<svg ` / `<svg\t` / `<svg\n` (attributes follow) and
          // `<svg>` (no attributes) — preserving the trailing delimiter.
          __html: iconSvg.replace(/<svg(\s|>)/i, '<svg width="100%" height="100%"$1'),
        }}
      />
    );
  }

  // Fallback glyph — MCP mark for MCP servers, plug for HTTP services.
  // The generic glyph must stay legible against the card, so it ignores
  // `brandColor` (which can be near-black/near-white and vanish on one theme)
  // and uses a theme-safe token on a subtle neutral tile. brandColor still tints
  // the light chip behind REAL logos above.
  const pad = Math.round(size * 0.16);
  return (
    <span
      className={className}
      style={{
        ...wrapStyle,
        boxSizing: "border-box",
        padding: pad,
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        background: "var(--surface-2)",
        color: "var(--text-secondary)",
        alignItems: "center",
        justifyContent: "center",
      }}
      aria-hidden
    >
      <svg width="100%" height="100%" viewBox="0 0 24 24" focusable={false}>
        {kind === "service" ? (
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 7V4m6 3V4M7.5 7h9v4a4.5 4.5 0 0 1-9 0V7Zm4.5 9v4"
          />
        ) : (
          MCP_LOGO_PATHS.map((d) => <path key={d} fill="currentColor" d={d} />)
        )}
      </svg>
    </span>
  );
}
