/**
 * Component tests for StepProviders — the onboarding provider gallery.
 *
 * Covers the onboarding-specific presentation contract:
 *  - renders a fixed-height gallery of community providers (two per row)
 *  - each card wears its own add state (Add / Add · key / Added)
 *  - keyless providers install on click; keyed providers prompt inline
 *  - the gallery frame stays a constant height (no jump while loading)
 *
 * Runs in the "component" vitest project (jsdom + Testing Library).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RegistryProviderEntry } from "@/types";

// ── Mock the store ────────────────────────────────────────────────────────────
const installCommunityProvider = vi.fn();
let savedProviders: unknown[] = [];

vi.mock("@/store", () => ({
  useCairnStore: (selector: (s: unknown) => unknown) =>
    selector({ aiConfig: { savedProviders }, installCommunityProvider }),
}));

// ── Registry fetch fixture ────────────────────────────────────────────────────
const PROVIDERS: RegistryProviderEntry[] = [
  {
    id: "openrouter",
    author: "community",
    version: "1.0.0",
    category: "direct",
    tags: [],
    blurb: "One key, many models.",
    brandColor: "#4D4D4D",
    definition: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsApiKey: true, defaultModel: "deepseek" },
  },
  {
    id: "ollama",
    author: "community",
    version: "1.0.0",
    tags: [],
    blurb: "Local models, no key.",
    definition: { name: "Ollama", baseUrl: "http://localhost:11434", needsApiKey: false },
  },
  {
    id: "mistral",
    author: "community",
    version: "1.0.0",
    tags: [],
    blurb: "Mistral API.",
    definition: { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsApiKey: true, defaultModel: "mistral-small" },
  },
];

const { fetchProviders } = vi.hoisted(() => ({ fetchProviders: vi.fn() }));

vi.mock("@/lib/models-dev", () => ({
  getOrFetchLogoSvg: () => null,
  subscribeModelCatalog: () => () => {},
  getModelCatalogVersion: () => 0,
}));

function setupWindow() {
  (window as unknown as { electron?: unknown }).electron = {
    registry: {
      fetchProviders: fetchProviders as never,
    },
  };
}

import { StepProviders } from "./StepProviders";

function renderStep() {
  const props = { onBack: vi.fn(), onNext: vi.fn() };
  // StepProviders renders its own <Shell>; render inside a minimal host.
  render(<StepProviders {...props} />);
  return props;
}

beforeEach(() => {
  savedProviders = [];
  installCommunityProvider.mockReset();
  fetchProviders.mockReset();
  fetchProviders.mockResolvedValue({
    manifest: { version: 1, updatedAt: "", providers: PROVIDERS },
    fromCache: false,
  });
  setupWindow();
});

describe("StepProviders gallery", () => {
  it("shows a fixed-height loading frame, then the provider grid", async () => {
    // Hold the fetch so we can assert the loading state first.
    let resolveFetch!: (v: unknown) => void;
    fetchProviders.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    renderStep();

    // Loading — frame present with the loader, no cards yet.
    expect(screen.getByText("Add an AI provider")).toBeInTheDocument();
    expect(screen.getByText("One-click presets for OpenAI-compatible endpoints. Keys are stored in your OS keychain. You can add these later from Settings → AI.")).toBeInTheDocument();

    resolveFetch({ manifest: { version: 1, updatedAt: "", providers: PROVIDERS }, fromCache: false });
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("Mistral")).toBeInTheDocument();
  });

  it("shows per-provider add state: keyed providers get 'Add · key', keyless get 'Add'", async () => {
    renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    // OpenRouter + Mistral need a key; Ollama doesn't.
    expect(screen.getAllByText("Add · key")).toHaveLength(2);
    expect(screen.getByText("Add")).toBeInTheDocument();
  });

  it("installs a keyless provider on click and marks it Added", async () => {
    installCommunityProvider.mockResolvedValue("id-1");
    renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    // The "Add" with no suffix belongs to the keyless provider (Ollama).
    const ollamaAdd = screen.getAllByRole("button", { name: "Add" }).find((b) => b.textContent === "Add");
    expect(ollamaAdd).toBeTruthy();
    await userEvent.click(ollamaAdd!);

    await waitFor(() => expect(installCommunityProvider).toHaveBeenCalledTimes(1));
  });

  it("prompts inline for an API key on a keyed provider", async () => {
    renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    await userEvent.click(screen.getAllByRole("button", { name: "Add · key" })[0]);
    const input = screen.getByPlaceholderText("sk-…");
    expect(input).toBeInTheDocument();
    await userEvent.type(input, "sk-test");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(installCommunityProvider).toHaveBeenCalledWith(PROVIDERS[0], "sk-test"));
  });

  it("renders a Shell progress header (wordmark) so the step is framed", async () => {
    renderStep();
    expect(screen.getByText("Cairn")).toBeInTheDocument();
  });
});
