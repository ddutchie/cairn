import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsRow } from "./form-row";
import { Button } from "./button";

/**
 * The row label names a form control, but never replaces a button's own text
 * as its accessible name.
 */
describe("SettingsRow labelling", () => {
  it("labels a form control with the row label", () => {
    render(<SettingsRow label="Workspace name"><input defaultValue="Cairn HQ" /></SettingsRow>);
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBeInTheDocument();
  });

  it("leaves a native button named by its own text", () => {
    render(<SettingsRow label="Community providers"><button type="button">Browse Community</button></SettingsRow>);
    expect(screen.getByRole("button", { name: "Browse Community" })).toBeInTheDocument();
  });

  it("leaves a Button named by its own text", () => {
    render(<SettingsRow label="Export data"><Button>Export</Button></SettingsRow>);
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });
});
