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
          background: "#f5f4f2",
          color: color || "#1a1a1a",
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
          // Model Context Protocol mark (generic "an MCP connector" glyph).
          <path
            fill="currentColor"
            d="M13.85 2a4.16 4.16 0 0 0-2.95 1.22L2.46 11.66a.84.84 0 0 0 1.18 1.18l8.44-8.44a2.49 2.49 0 0 1 3.54 3.54l-6.02 6.02-.1.1a.84.84 0 0 0 1.18 1.19l6.12-6.12a2.49 2.49 0 0 1 3.54 0 2.49 2.49 0 0 1 0 3.54l-8.53 8.53a.84.84 0 0 0 0 1.18l.53.53a.84.84 0 0 0 1.18 0l8.53-8.53a4.17 4.17 0 0 0-5.9-5.9l-.06.06a4.16 4.16 0 0 0-6.9-4.5A4.16 4.16 0 0 0 13.85 2Z"
          />
        )}
      </svg>
    </span>
  );
}
