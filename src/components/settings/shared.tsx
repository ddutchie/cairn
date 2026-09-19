"use client";

/**
 * Backwards-compatibility shim — the form-row primitives live in
 * `@/components/ui/form-row` now. Import from there in new code.
 */

export {
  SettingsGroup,
  SettingsRow,
  Toggle,
  StepperSettingsRow,
  type StepperIcon,
} from "@/components/ui/form-row";
