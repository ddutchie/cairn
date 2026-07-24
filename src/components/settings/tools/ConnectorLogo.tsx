/**
 * ConnectorLogo — maps a community-registry `logo` id (from cairn-community's
 * manifest.json) to a bundled inline SVG brand glyph.
 *
 * Inline SVG (not static assets) because the app is a Next.js static export
 * (`output: "export"`) where renderer asset paths are fragile, and because
 * inlining lets a glyph inherit the connector's `brandColor` at the call site.
 *
 * Unknown ids fall back to a generic plug glyph, so a newly-added registry
 * entry whose logo we don't bundle yet still renders cleanly (never a broken
 * image). Add a new case here when the registry gains a connector.
 */

import type { CSSProperties } from "react";

export interface ConnectorLogoProps {
  /** Stable logo id from the manifest entry (e.g. "jira", "linear"). */
  logo?: string;
  /** Pixel size of the square glyph. */
  size?: number;
  /** Brand colour from the manifest entry; used as the glyph fill. */
  color?: string;
  className?: string;
  style?: CSSProperties;
}

/** All logo ids this component renders a dedicated glyph for. */
export const KNOWN_CONNECTOR_LOGOS = [
  "jira",
  "confluence",
  "linear",
  "notion",
  "monday",
  "github",
  "sentry",
  "brave",
  "hackernews",
  "asana",
  "stripe",
  "hubspot",
  "canva",
  "intercom",
  "cloudflare",
  "vercel",
  "zapier",
] as const;

export function ConnectorLogo({
  logo,
  size = 24,
  color,
  className,
  style,
}: ConnectorLogoProps) {
  const fill = color || "var(--text-secondary)";
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    style,
    "aria-hidden": true,
    focusable: false as const,
  };

  switch ((logo || "").toLowerCase()) {
    case "jira":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M11.53 2 4 9.53a1.2 1.2 0 0 0 0 1.7l7.53 7.54 3.4-3.4-4.14-4.14a.6.6 0 0 1 0-.85l4.14-4.14L11.53 2Z"
          />
          <path
            fill={fill}
            opacity="0.6"
            d="M12.47 22 20 14.47a1.2 1.2 0 0 0 0-1.7l-7.53-7.54-3.4 3.4 4.14 4.14a.6.6 0 0 1 0 .85l-4.14 4.14L12.47 22Z"
          />
        </svg>
      );
    case "confluence":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M3 16.5c3-4 6-5 9-3l3.5 1.8c.6.3.8 1 .4 1.6l-1.7 2.6c-.4.6-1 .7-1.6.4L9 18.2c-2-1-3.6-.3-5 1.2-.4.5-1.2.3-1.2-.4v-2.5Z"
          />
          <path
            fill={fill}
            opacity="0.6"
            d="M21 7.5c-3 4-6 5-9 3L8.5 8.7c-.6-.3-.8-1-.4-1.6l1.7-2.6c.4-.6 1-.7 1.6-.4L15 5.8c2 1 3.6.3 5-1.2.4-.5 1.2-.3 1.2.4v2.5Z"
          />
        </svg>
      );
    case "linear":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M2.2 13.6a10 10 0 0 0 8.2 8.2L2.2 13.6ZM2 11.2 12.8 22a10 10 0 0 0 2.6-.6L2.6 8.6a10 10 0 0 0-.6 2.6ZM3.6 6.6 17.4 20.4a10 10 0 0 0 2-1.4L5 4.6a10 10 0 0 0-1.4 2ZM6.9 3.1 20.9 17a10 10 0 0 0-14-14Z"
          />
        </svg>
      );
    case "notion":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M5 4.3 15.4 3.5c1.2-.1 1.6 0 2.3.5l2 1.5c.5.4.6.5.6 1v12.3c0 .8-.3 1.3-1.3 1.4l-11 .7c-.8 0-1.2-.1-1.6-.6l-2-2.6c-.4-.6-.6-1-.6-1.6V5.6c0-.7.3-1.2 1.2-1.3Z"
          />
          <path
            fill="var(--background)"
            d="M8 7.4v8.9l1.6-.1V10l4.7 6.1 1.5-.1V7.2l-1.6.1v5.9L9.6 7.3 8 7.4Z"
          />
        </svg>
      );
    case "monday":
      return (
        <svg {...common} viewBox="0 0 24 24">
          <circle cx="4.5" cy="15" r="2.6" fill={fill} />
          <circle cx="12" cy="15" r="2.6" fill={fill} opacity="0.7" />
          <circle cx="19.5" cy="15" r="2.6" fill={fill} opacity="0.45" />
          <path
            fill={fill}
            d="M2.4 12.6 6 6.3a1.5 1.5 0 0 1 2.6 1.5L5 14.1a1.5 1.5 0 0 1-2.6-1.5Z"
            opacity="0"
          />
        </svg>
      );
    case "github":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
          />
        </svg>
      );
    case "sentry":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M13.5 3.3a1.8 1.8 0 0 0-3 0L2.6 17a1.5 1.5 0 0 0 1.3 2.3H7a7.5 7.5 0 0 0-3.2-6.1l1.5-2.6A10.5 10.5 0 0 1 10 19.3h3.2a13.5 13.5 0 0 0-6-11.3l1.3-2.3 8.2 14.1H14a1.5 1.5 0 0 1 0 0h4.1a1.5 1.5 0 0 0 1.3-2.3L13.5 3.3Z"
          />
        </svg>
      );
    case "brave":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M12 2 6.5 3.6 5 5.2 3 5.7l1 3.2-1 2.6c0 3.6 3.4 6.6 9 9.5 5.6-2.9 9-5.9 9-9.5l-1-2.6 1-3.2-2-.5-1.5-1.6L12 2Zm0 4.6 2.9 1 .8 2.4-2.1 2.2c-.4.4-1 .4-1.2 0L9.3 10l.8-2.4 1.9-.7Z"
          />
        </svg>
      );
    case "hackernews":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" fill={fill} />
          <path
            fill="var(--background)"
            d="M12 13.3 8.7 7.5h1.7L12 10.9l1.6-3.4h1.7L12 13.3v3.2h-1.3v-3.2H12Z"
          />
        </svg>
      );
    case "asana":
      return (
        <svg {...common}>
          <circle cx="12" cy="6.3" r="3.1" fill={fill} />
          <circle cx="6.4" cy="15.6" r="3.1" fill={fill} />
          <circle cx="17.6" cy="15.6" r="3.1" fill={fill} />
        </svg>
      );
    case "stripe":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M11.6 9.6c0-.6.5-.85 1.3-.85 1.15 0 2.6.35 3.75.97V6.15A9.9 9.9 0 0 0 12.9 5.4C10 5.4 8 6.9 8 9.5c0 4 5.35 3.3 5.35 5.05 0 .7-.6.93-1.45.93-1.25 0-2.9-.52-4.2-1.2v3.6c1.4.6 2.85.86 4.2.86 3 0 5.05-1.45 5.05-4.1 0-4.3-5.35-3.5-5.35-5.04Z"
          />
        </svg>
      );
    case "hubspot":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M16.5 8.6V6.2a1.9 1.9 0 1 0-1.7 0v2.4a5.3 5.3 0 0 0-2.2.95L7 5.7a2 2 0 1 0-1 1.35l5.4 4.2a5 5 0 1 0 5.1-2.65Zm-1 8.9a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z"
          />
        </svg>
      );
    case "canva":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9.2" fill={fill} />
          <path
            fill="var(--background)"
            d="M14.9 14.2c-.9 1.1-2.1 1.8-3.3 1.8-1.9 0-3.1-1.5-3.1-3.7 0-2.9 1.8-5.2 3.9-5.2 1 0 1.7.6 1.7 1.4 0 .5-.2.9-.5 1.2-.2-.7-.6-1.1-1.2-1.1-1.2 0-2.2 1.7-2.2 3.6 0 1.3.6 2.1 1.5 2.1.8 0 1.6-.5 2.3-1.4l.9 1.3Z"
          />
        </svg>
      );
    case "intercom":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill={fill} />
          <path
            stroke="var(--background)"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
            d="M8 8v4.5M12 8.4v5M16 8v4.5M8 16c2.5 1.2 5.5 1.2 8 0"
          />
        </svg>
      );
    case "cloudflare":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M16.9 15.5c.15-.5.1-1-.15-1.35-.23-.32-.6-.5-1.05-.52l-8.2-.1a.16.16 0 0 1-.13-.07.17.17 0 0 1 0-.16c.02-.06.08-.1.15-.11l8.3-.1c.98-.05 2.05-.85 2.42-1.83l.47-1.24a.28.28 0 0 0 .01-.16 5.4 5.4 0 0 0-10.38-.55A2.44 2.44 0 0 0 4.5 12.9c0 .18.01.36.04.53a.16.16 0 0 1-.16.18l-.2.01c-.72.1-1.28.72-1.28 1.46 0 .16.02.32.06.47a.16.16 0 0 0 .15.11h13.5a.2.2 0 0 0 .19-.14l.1-.5Z"
          />
        </svg>
      );
    case "vercel":
      return (
        <svg {...common}>
          <path fill={fill} d="M12 3.5 21 20H3L12 3.5Z" />
        </svg>
      );
    case "zapier":
      return (
        <svg {...common}>
          <path
            fill={fill}
            d="M14.4 12a5.9 5.9 0 0 1-.38 2.08c-.66.24-1.36.37-2.02.37-.67 0-1.37-.13-2.02-.37A5.9 5.9 0 0 1 9.6 12c0-.72.13-1.42.38-2.08A5.9 5.9 0 0 1 12 9.55c.67 0 1.36.13 2.02.37.25.66.38 1.36.38 2.08Zm7.35-1.47h-5.03l3.56-3.56-1.25-1.25-3.56 3.56V3.75h-1.77v5.03l-1.7-1.7-1.86 1.86 1.7 1.7H3.75v1.77h5.03l-3.56 3.56 1.25 1.25 3.56-3.56v5.03h1.77v-5.03l3.56 3.56 1.25-1.25-3.56-3.56h5.03v-1.77Z"
          />
        </svg>
      );
    default:
      // Generic connector fallback — a plug glyph.
      return (
        <svg {...common}>
          <path
            fill="none"
            stroke={fill}
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 7V4m6 3V4M7.5 7h9v4a4.5 4.5 0 0 1-9 0V7Zm4.5 9v4"
          />
        </svg>
      );
  }
}
