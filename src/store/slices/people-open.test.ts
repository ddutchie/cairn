import { describe, it, expect, beforeEach } from "vitest";
import { useCairnStore } from "@/store";

describe("openPerson", () => {
  beforeEach(() => {
    useCairnStore.setState({ activeView: "overview", selectedPersonId: null, activePreviewItem: null, activeContextPanel: null, sessionPresentation: "drawer" });
  });

  it("opens the People view on that person from anywhere else", () => {
    useCairnStore.getState().openPerson("p1");
    expect(useCairnStore.getState().activeView).toBe("people");
    expect(useCairnStore.getState().selectedPersonId).toBe("p1");
    expect(useCairnStore.getState().activeContextPanel).toBeNull();
  });

  it("opens the preview pane beside a full-width chat, without leaving it", () => {
    useCairnStore.setState({ activeView: "chat", sessionPresentation: "center" });
    useCairnStore.getState().openPerson("p1");
    expect(useCairnStore.getState().activeView).toBe("chat");
    expect(useCairnStore.getState().activeContextPanel).toEqual({ type: "person", id: "p1" });
  });
});
