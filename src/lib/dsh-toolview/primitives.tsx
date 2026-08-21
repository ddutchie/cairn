/**
 * §11 spike — minimal local stand-ins for the four
 * @deepseek-ai/dsh-client-ui-primitives exports the vendored SkillRow imports.
 *
 * WHY stand-ins instead of the real package: ui-primitives pulls a heavy stack
 * (shiki, katex, micromark) + peers cordis into the renderer — far too much for
 * a spike whose point is proving the CONTRACT + THEME bridge, not markdown
 * rendering. These match the real component signatures (`{ size, className }`
 * for icons, `{ state, size, className }` for StateDot) so swapping in the real
 * package later is a drop-in. The visuals are Cairn's lucide icons + a themed
 * dot, styled through the same `--dsw-*` tokens.
 */
import React from "react";
import { Sparkles, ChevronDown, Search } from "lucide-react";

type IconProps = { size?: number; className?: string };

export const IconSkillOutline16 = ({ size = 16, className }: IconProps) => (
  <Sparkles size={size} className={className} />
);

export const IconChevronDownOutline14 = ({ size = 14, className }: IconProps) => (
  <ChevronDown size={size} className={className} />
);

export const IconInspectOutline12 = ({ size = 12, className }: IconProps) => (
  <Search size={size} className={className} />
);

export type StateDotState = "done" | "warning" | "ongoing" | "error";

const STATE_COLOR: Record<StateDotState, string> = {
  done: "var(--dsw-alias-state-success-primary)",
  warning: "var(--dsw-alias-state-warn-primary)",
  ongoing: "var(--dsw-static-deepseek-450)",
  error: "var(--dsw-alias-state-error-primary)",
};

export function StateDot({ state, size = 10, className }: { state: StateDotState; size?: number; className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size * 0.6,
        height: size * 0.6,
        borderRadius: "50%",
        background: STATE_COLOR[state],
        boxShadow: `0 0 0 ${size * 0.2}px color-mix(in srgb, ${STATE_COLOR[state]} 12%, transparent)`,
      }}
    />
  );
}
