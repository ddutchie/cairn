/**
 * Component test for StepAppearance — the first configuration slide (theme,
 * text size, note font).
 *
 * Note font was added to onboarding in v2.7.6 when the wizard was trimmed to
 * folder → workspace → appearance → AI → land. This guards that the note-font
 * picker is present and drives both the store setter and the live
 * `applyFontFamily` side effect (so the choice is visible immediately, not just
 * after finishing onboarding).
 *
 * Runs in the "component" vitest project (jsdom + Testing Library).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepAppearance } from "./StepAppearance";
import { FONT_PRESETS } from "../../../shared/ui/fonts";

function renderStep(overrides: Partial<React.ComponentProps<typeof StepAppearance>> = {}) {
  const props = {
    theme: "system" as const,
    fontScale: 1.2 as const,
    fontFamily: "sans" as const,
    onThemeChange: vi.fn(),
    onFontScaleChange: vi.fn(),
    onFontFamilyChange: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
  render(<StepAppearance {...props} />);
  return props;
}

describe("StepAppearance", () => {
  it("renders a button for every note-font preset", () => {
    renderStep();
    for (const preset of FONT_PRESETS) {
      // The button's accessible name is the preview glyph ("Ag") + the label,
      // so match on the label as a substring rather than exactly.
      expect(
        screen.getByRole("button", { name: new RegExp(`${preset.name}$`) }),
      ).toBeInTheDocument();
    }
  });

  it("selecting a note font calls onFontFamilyChange and applies it live", async () => {
    const user = userEvent.setup();
    const props = renderStep({ fontFamily: "sans" });

    await user.click(screen.getByRole("button", { name: /Serif$/ }));

    expect(props.onFontFamilyChange).toHaveBeenCalledWith("serif");
    // applyFontFamily writes the preset stack to --font-note on <html>.
    const serif = FONT_PRESETS.find((p) => p.id === "serif")!;
    expect(document.documentElement.style.getPropertyValue("--font-note")).toBe(serif.cssFamily);
  });

  it("advances to the next step", async () => {
    const user = userEvent.setup();
    const props = renderStep();
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(props.onNext).toHaveBeenCalledTimes(1);
  });
});
