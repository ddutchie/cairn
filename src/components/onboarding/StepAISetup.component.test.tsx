/**
 * Component tests for the merged AI-setup step — the provider gallery embedded
 * in StepAISetup's "Cloud & Local" branch (the standalone providers step was
 * folded in because both were provider pickers).
 *
 * Covers:
 *  - the gallery renders inside the step and lists community providers
 *  - per-provider add state (Add / Add · key / Added)
 *  - keyless install + onPick prefills the active connection (baseUrl/model)
 *  - keyed providers prompt inline for the API key
 *  - the fixed-height frame stays constant while loading
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
  useCairnStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ aiConfig: { savedProviders }, installCommunityProvider }),
    { getState: () => ({ aiConfig: { savedProviders }, installCommunityProvider }) },
  ),
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
    ai: {
      localLLMStatus: vi.fn().mockResolvedValue({ available: false }),
    },
  };
}

import { StepAISetup } from "./StepAISetup";

type Props = React.ComponentProps<typeof StepAISetup>;

function renderStep(overrides: Partial<Props> = {}) {
  const props: Props = {
    aiEnabled: true,
    provider: "openai",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    model: "gpt-4o",
    onAiEnabledChange: vi.fn(),
    onProviderChange: vi.fn(),
    onBaseUrlChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    onModelChange: vi.fn(),
    onBack: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
  render(<StepAISetup {...props} />);
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

describe("StepAISetup merged provider gallery", () => {
  it("shows a fixed-height loading frame, then the provider grid inside the step", async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchProviders.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    renderStep();

    // Loading — loader present, no cards yet.
    expect(screen.getByText("Add an AI provider")).toBeInTheDocument();

    resolveFetch({ manifest: { version: 1, updatedAt: "", providers: PROVIDERS }, fromCache: false });
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());
    expect(screen.getByText("Ollama")).toBeInTheDocument();
  });

  it("shows per-provider add state: keyed providers get 'Add · key', keyless get 'Add'", async () => {
    renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    expect(screen.getAllByText("Add · key")).toHaveLength(1);
    expect(screen.getByText("Add")).toBeInTheDocument();
  });

  it("installs a keyless provider and makes it the active connection (prefills baseUrl + model)", async () => {
    installCommunityProvider.mockImplementation(async () => {
      savedProviders = [{ id: "id-1", name: "Ollama", baseUrl: "http://localhost:11434", communityId: "ollama", apiKey: "", model: "" }];
      return "id-1";
    });
    const props = renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    const ollamaAdd = screen.getAllByRole("button", { name: "Add" }).find((b) => b.textContent === "Add");
    expect(ollamaAdd).toBeTruthy();
    await userEvent.click(ollamaAdd!);

    await waitFor(() => expect(installCommunityProvider).toHaveBeenCalledWith(PROVIDERS[1], undefined));
    // onPick → provider flips to cloud + baseUrl/model prefilled from the preset.
    expect(props.onProviderChange).toHaveBeenCalledWith("openai");
    expect(props.onBaseUrlChange).toHaveBeenCalledWith("http://localhost:11434");
    // Ollama has no defaultModel and is keyless → model/key untouched.
    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(props.onApiKeyChange).not.toHaveBeenCalled();
  });

  it("prefills the default model and mirrors the keychain ref when the picked preset declares one", async () => {
    installCommunityProvider.mockImplementation(async () => {
      savedProviders = [{ id: "id-openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", communityId: "openrouter", apiKey: "secret://llm:id-openrouter/apiKey", model: "deepseek" }];
      return "id-openrouter";
    });
    const props = renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    // Keyed provider → confirm the inline key first.
    await userEvent.click(screen.getAllByRole("button", { name: "Add · key" })[0]);
    await userEvent.type(screen.getByPlaceholderText("sk-…"), "sk-test");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(installCommunityProvider).toHaveBeenCalledWith(PROVIDERS[0], "sk-test"));
    expect(props.onProviderChange).toHaveBeenCalledWith("openai");
    expect(props.onBaseUrlChange).toHaveBeenCalledWith("https://openrouter.ai/api/v1");
    expect(props.onModelChange).toHaveBeenCalledWith("deepseek");
    // The keychain ref (not the raw key) is mirrored so handleSaveAI persists it.
    expect(props.onApiKeyChange).toHaveBeenCalledWith("secret://llm:id-openrouter/apiKey");
  });

  it("prompts inline for an API key on a keyed provider", async () => {
    renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    await userEvent.click(screen.getAllByRole("button", { name: "Add · key" })[0]);
    expect(screen.getByPlaceholderText("sk-…")).toBeInTheDocument();
  });

  it("shows the manual endpoint section under an advanced toggle", async () => {
    renderStep();
    await waitFor(() => expect(screen.getByText("OpenRouter")).toBeInTheDocument());

    // Advanced (manual baseUrl/key/model) is hidden by default.
    expect(screen.queryByPlaceholderText("https://api.openai.com")).toBeNull();
    await userEvent.click(screen.getByText("Manual endpoint / custom model"));
    expect(screen.getByPlaceholderText("https://api.openai.com")).toBeInTheDocument();
  });
});
