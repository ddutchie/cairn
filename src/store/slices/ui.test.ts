/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUISlice, SEEN_FEATURES_KEY, dedupeProviders } from "./ui";

// Mock the persistence layer so we can assert markFeatureAsSeen's storage
// contract (node project has no window, so storage.set is otherwise a no-op).
// The spy lives in vi.hoisted() because vi.mock() is hoisted above normal
// declarations and its factory closes over storageSet.
const { storageSet } = vi.hoisted(() => ({ storageSet: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  storage: {
    get: vi.fn(() => null),
    set: (...args: unknown[]) => storageSet(...args),
    delete: vi.fn(),
    clear: vi.fn(),
  },
}));

describe("createUISlice", () => {
  it("initializes with overview as activeView and lastContentView", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
    expect(state.sessionPresentation).toBe("drawer");
  });

  it("setView updates activeView and lastContentView for content views", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    // Navigate to board (a content view)
    state.setView("board");
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");

    // Navigate to notes (a content view)
    state.setView("notes");
    expect(state.activeView).toBe("notes");
    expect(state.lastContentView).toBe("notes");
  });

  it("setView does not update lastContentView when entering chat or search mode", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    // Set a baseline content view
    state.setView("board");
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");

    // Switch to chat
    state.setView("chat");
    expect(state.activeView).toBe("chat");
    expect(state.lastContentView).toBe("board"); // remains "board"

    // Switch to search
    state.setView("search");
    expect(state.activeView).toBe("search");
    expect(state.lastContentView).toBe("board"); // remains "board"
  });

  it("keeps conversation presentation independent from content view navigation", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    state.setView("chat");
    expect(state.sessionPresentation).toBe("center");

    state.setSessionPresentation("drawer");
    expect(state.activeView).toBe("chat");
    expect(state.sessionPresentation).toBe("drawer");

    state.setView("agent");
    expect(state.sessionPresentation).toBe("drawer");
  });

  it("opens the global Chat affordance in the drawer", () => {
    let state: any = { sessionPresentation: "center" };

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice, sessionPresentation: "center" };

    state.toggleChat();
    expect(state.chatOpen).toBe(true);
    expect(state.sessionPresentation).toBe("drawer");
  });

  it("setActiveWorkspace and setActiveProject reset lastContentView to overview", () => {
    let state: any = {
      projects: [
        { id: "p1", workspaceId: "w1" },
        { id: "p2", workspaceId: "w2" },
      ],
    };

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    // Set a baseline
    state.setView("board");
    state.setActivePreviewItem({ type: "note", id: "note-1" });
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");
    expect(state.activePreviewItem).toEqual({ type: "note", id: "note-1" });

    // Set active project
    state.setActiveProject("p1");
    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
    expect(state.activePreviewItem).toBeNull();

    // Navigate back to board and set a preview item
    state.setView("board");
    state.setActivePreviewItem({ type: "task", id: "card-1" });
    expect(state.lastContentView).toBe("board");
    expect(state.activePreviewItem).toEqual({ type: "task", id: "card-1" });

    // Set active workspace
    state.setActiveWorkspace("w2");
    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
    expect(state.activePreviewItem).toBeNull();
  });
});

// ── Tour / What's New feature state ──────────────────────────────────────────

describe("createUISlice — tour & seen-features state", () => {
  beforeEach(() => {
    storageSet.mockClear();
  });

  function setup() {
    let state: any = {};
    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };
    return { get: () => state };
  }

  it("initializes tour/feature state to defaults", () => {
    const { get } = setup();
    expect(get().seenFeatures).toEqual([]);
    expect(get().tutorialActive).toBe(false);
    expect(get().tutorialStepIndex).toBe(0);
  });

  it("markFeatureAsSeen appends an unseen feature id", () => {
    const { get } = setup();
    get().markFeatureAsSeen("v2.3.2-onboarding-tour");
    expect(get().seenFeatures).toEqual(["v2.3.2-onboarding-tour"]);
    // Persists the new array under the seen-features key.
    expect(storageSet).toHaveBeenLastCalledWith(SEEN_FEATURES_KEY, ["v2.3.2-onboarding-tour"]);
  });

  it("markFeatureAsSeen is idempotent for an already-seen id", () => {
    const { get } = setup();
    get().markFeatureAsSeen("a");
    get().markFeatureAsSeen("a");
    expect(get().seenFeatures).toEqual(["a"]);
    // Re-persists the unchanged array (no duplicate id).
    expect(storageSet).toHaveBeenLastCalledWith(SEEN_FEATURES_KEY, ["a"]);
  });

  it("markFeatureAsSeen accumulates distinct ids in order", () => {
    const { get } = setup();
    get().markFeatureAsSeen("a");
    get().markFeatureAsSeen("b");
    get().markFeatureAsSeen("a"); // duplicate, ignored
    get().markFeatureAsSeen("c");
    expect(get().seenFeatures).toEqual(["a", "b", "c"]);
    // Final persisted value matches the in-memory ordered set.
    expect(storageSet).toHaveBeenLastCalledWith(SEEN_FEATURES_KEY, ["a", "b", "c"]);
  });

  it("setTutorialActive(true) activates the tour and resets the step index", () => {
    const { get } = setup();
    // Advance the step first so the reset side-effect is observable.
    get().setTutorialStepIndex(3);
    expect(get().tutorialStepIndex).toBe(3);

    get().setTutorialActive(true);
    expect(get().tutorialActive).toBe(true);
    expect(get().tutorialStepIndex).toBe(0); // reset on activate
  });

  it("setTutorialActive(false) deactivates the tour and resets the step index", () => {
    const { get } = setup();
    get().setTutorialStepIndex(2);
    get().setTutorialActive(false);
    expect(get().tutorialActive).toBe(false);
    expect(get().tutorialStepIndex).toBe(0);
  });

  it("setTutorialStepIndex updates the step index", () => {
    const { get } = setup();
    get().setTutorialStepIndex(4);
    expect(get().tutorialStepIndex).toBe(4);
  });
});

describe("dedupeProviders", () => {
  const P = (id: string, name = id) => ({ id, name, baseUrl: "https://x", apiKey: "", model: "m" });

  it("returns the list unchanged when all ids are unique", () => {
    const list = [P("a"), P("b"), P("c")];
    expect(dedupeProviders(list)).toEqual(list);
  });

  it("removes duplicate ids, keeping first-seen order", () => {
    const out = dedupeProviders([P("a"), P("b"), P("a"), P("c")]);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the LAST value for a duplicated id (later edit wins)", () => {
    const out = dedupeProviders([P("a", "old"), P("b"), P("a", "new")]);
    expect(out.find((p) => p.id === "a")?.name).toBe("new");
  });

  it("handles an empty list", () => {
    expect(dedupeProviders([])).toEqual([]);
  });
});

describe("toggleFavoriteModel", () => {
  const setup = () => {
    let state: any = {};
    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };
    return { get: () => state };
  };

  it("starts with no favorites", () => {
    const { get } = setup();
    expect(get().favoriteModels.size).toBe(0);
  });

  it("adds a model on first toggle and removes it on the second", () => {
    const { get } = setup();
    get().toggleFavoriteModel("gpt-4o");
    expect(get().favoriteModels.has("gpt-4o")).toBe(true);
    get().toggleFavoriteModel("gpt-4o");
    expect(get().favoriteModels.has("gpt-4o")).toBe(false);
  });

  it("persists favorites to storage on toggle", () => {
    const { get } = setup();
    get().toggleFavoriteModel("claude-sonnet");
    expect(storageSet).toHaveBeenCalledWith("favoriteModels", ["claude-sonnet"]);
  });
});

describe("installCommunityProvider", () => {
  // The install path stores the API key via the keychain bridge and keeps only
  // a `secret://` reference in the store. Mock the bridge so we exercise the
  // real (secure) path; the ref echoes the id so we can assert per-row.
  beforeEach(() => {
    (globalThis as any).window = {
      electron: {
        secrets: {
          set: vi.fn(async (kind: string, id: string, key: string) => `secret://${kind}:${id}/${key}`),
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as any).window;
  });

  function setup() {
    let state: any = {};
    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };
    return { get: () => state };
  }

  const entry = {
    id: "openrouter",
    definition: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api", defaultModel: "openai/gpt-4o-mini" },
  };

  it("adds a community provider to the shared list with source + communityId", async () => {
    const { get } = setup();
    const id = await get().installCommunityProvider(entry, "sk-test");
    const list = get().aiConfig.savedProviders;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].source).toBe("community");
    expect(list[0].communityId).toBe("openrouter");
    expect(list[0].baseUrl).toBe("https://openrouter.ai/api");
    expect(list[0].model).toBe("openai/gpt-4o-mini");
    // Only the keychain reference is stored — never the raw key.
    expect(list[0].apiKey).toBe(`secret://llm:${id}/apiKey`);
  });

  it("does not auto-select the provider for any surface", async () => {
    const { get } = setup();
    await get().installCommunityProvider(entry, "sk-test");
    expect(get().aiConfig.activeProviderId).toBeUndefined();
    expect(get().agentConfig.activeProviderId).toBeUndefined();
  });

  it("reuses the existing row on re-install (dedup by communityId)", async () => {
    const { get } = setup();
    const firstId = await get().installCommunityProvider(entry, "sk-old");
    const secondId = await get().installCommunityProvider(
      { ...entry, definition: { ...entry.definition, defaultModel: "openai/gpt-4o" } },
      "sk-new",
    );
    expect(secondId).toBe(firstId);
    const list = get().aiConfig.savedProviders;
    expect(list).toHaveLength(1);
    expect(list[0].model).toBe("openai/gpt-4o");
    expect(list[0].apiKey).toBe(`secret://llm:${firstId}/apiKey`);
  });

  it("rejects a keyed install when secure storage is unavailable", async () => {
    delete (globalThis as any).window; // no keychain bridge
    const { get } = setup();
    await expect(get().installCommunityProvider(entry, "sk-test")).rejects.toThrow(/secure storage/i);
    expect(get().aiConfig.savedProviders ?? []).toHaveLength(0);
  });

  it("adds a keyless provider without a secure-storage bridge", async () => {
    delete (globalThis as any).window;
    const { get } = setup();
    const keyless = { ...entry, definition: { ...entry.definition, name: "Local" } };
    const id = await get().installCommunityProvider(keyless); // no apiKey
    const list = get().aiConfig.savedProviders;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].apiKey).toBe("");
  });
});

describe("chat personalities", () => {
  function setup() {
    let state: any = {};
    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };
    return { get: () => state };
  }

  const entry = {
    id: "grill-me",
    author: "cairn",
    version: "1.0.0",
    brandColor: "#f43f5e",
    homepage: "https://github.com/JuliusBrussee/skills",
    definition: {
      name: "Grill Me",
      description: "Calibrated grilling.",
      prompt: "Pressure-test plans with calibrated questions. Ask one question at a time.",
    },
  };

  it("installCommunityPersonality adds a community row with source + communityId, no auto-select", async () => {
    const { get } = setup();
    const id = await get().installCommunityPersonality(entry);
    const list = get().aiConfig.installedPersonalities;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].source).toBe("community");
    expect(list[0].communityId).toBe("grill-me");
    expect(list[0].prompt).toContain("Pressure-test plans");
    expect(list[0].homepage).toBe("https://github.com/JuliusBrussee/skills");
    expect(get().aiConfig.personalityId).toBeUndefined(); // never auto-selects
  });

  it("re-install dedups by communityId and updates the row", async () => {
    const { get } = setup();
    const firstId = await get().installCommunityPersonality(entry);
    const secondId = await get().installCommunityPersonality({
      ...entry,
      definition: { ...entry.definition, prompt: "Updated rules." },
    });
    expect(secondId).toBe(firstId);
    const list = get().aiConfig.installedPersonalities;
    expect(list).toHaveLength(1);
    expect(list[0].prompt).toBe("Updated rules.");
  });

  it("setPersonality selects and clears (null = None)", () => {
    const { get } = setup();
    get().setPersonality("p1");
    expect(get().aiConfig.personalityId).toBe("p1");
    get().setPersonality(null);
    // "None" is stored as null (not undefined) so the backend cache can clear
    // its previous value and the choice survives a restart.
    expect(get().aiConfig.personalityId).toBeNull();
  });

  it("createCustomPersonality adds a custom row and returns its id", () => {
    const { get } = setup();
    const id = get().createCustomPersonality({ name: "Concise", prompt: "Always talk in ASD-STE100 Simplified English." });
    const row = get().aiConfig.installedPersonalities.find((p: any) => p.id === id);
    expect(row?.source).toBe("custom");
    expect(row?.name).toBe("Concise");
    expect(row?.communityId).toBeUndefined();
  });

  it("removePersonality deletes the row and clears the active selection if it was active", () => {
    const { get } = setup();
    const id = get().createCustomPersonality({ name: "Mine", prompt: "Be brief but correct." });
    get().setPersonality(id);
    expect(get().aiConfig.personalityId).toBe(id);
    get().removePersonality(id);
    expect(get().aiConfig.installedPersonalities).toHaveLength(0);
    expect(get().aiConfig.personalityId).toBeNull();
  });
});
