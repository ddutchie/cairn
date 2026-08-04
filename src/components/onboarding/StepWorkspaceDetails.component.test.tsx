import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepWorkspaceDetails } from "./StepWorkspaceDetails";

type Props = React.ComponentProps<typeof StepWorkspaceDetails>;

function renderStep(overrides: Partial<Props> = {}) {
  const props: Props = {
    chosenFolder: "/vault",
    name: "Knowledge",
    icon: "Folder",
    submitting: false,
    showBack: true,
    isObsidianVault: true,
    importPreview: {
      vaultName: "vault",
      noteCount: 8,
      skippedCount: 2,
      projects: [
        { name: "vault", noteCount: 2, root: true, projectKey: "vault" },
        { name: "Research", noteCount: 6, root: false, projectKey: "research" },
      ],
    },
    previewReady: true,
    excludedFolders: new Set(),
    onBack: vi.fn(),
    onNameChange: vi.fn(),
    onIconChange: vi.fn(),
    onToggleExcludedFolder: vi.fn(),
    onSubmit: vi.fn((event) => event.preventDefault()),
    ...overrides,
  };
  render(<StepWorkspaceDetails {...props} />);
  return props;
}

describe("StepWorkspaceDetails import preview", () => {
  it("shows import counts, skipped files, and backup guidance", () => {
    renderStep();
    expect(screen.getByText(/8 notes across 2 projects/i)).toBeInTheDocument();
    expect(screen.getByText(/2 template, Excalidraw, or infrastructure files/i)).toBeInTheDocument();
    expect(screen.getByText(/commit the vault to git or make a backup/i)).toBeInTheDocument();
  });

  it("recalculates the summary when a folder is excluded", () => {
    renderStep({ excludedFolders: new Set(["Research"]) });
    expect(screen.getByText(/2 notes across 1 projects/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Include Research" })).toHaveAttribute("aria-pressed", "false");
  });

  it("lets the user toggle an import folder", async () => {
    const user = userEvent.setup();
    const props = renderStep();
    await user.click(screen.getByRole("button", { name: "Exclude Research" }));
    expect(props.onToggleExcludedFolder).toHaveBeenCalledWith("Research");
  });

  it("blocks confirmation until the read-only preview completes", () => {
    renderStep({ previewReady: false, importPreview: null });
    expect(screen.getByRole("button", { name: "Waiting for preview…" })).toBeDisabled();
  });

  it("shows the preview for ordinary Markdown folders without .obsidian", () => {
    renderStep({ isObsidianVault: false });
    expect(screen.getByText(/8 notes across 2 projects/i)).toBeInTheDocument();
    expect(screen.getByText(/Markdown notes detected/i)).toBeInTheDocument();
  });
});
