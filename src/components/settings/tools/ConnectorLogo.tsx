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
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return false;
  if (/<script|<foreignobject|<iframe|<image|<use\b/i.test(s)) return false;
  if (/\son\w+\s*=/i.test(s)) return false; // inline event handlers
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
    // Safe: CI-sanitized + guarded above; `currentColor` in the markup inherits
    // the wrapper `color` (brandColor). Sized via CSS so the intrinsic
    // width/height in the markup don't matter.
    return (
      <span
        className={className}
        style={wrapStyle}
        aria-hidden
        // Safe: SVG is sanitized by cairn-community CI + guarded by looksSafeSvg above.
        dangerouslySetInnerHTML={{
          __html: iconSvg.replace(/<svg /i, '<svg width="100%" height="100%" '),
        }}
      />
    );
  }

  // Fallback glyph — MCP mark for MCP servers, plug for HTTP services.
  return (
    <span className={className} style={wrapStyle} aria-hidden>
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
