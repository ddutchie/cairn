import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const userData = mkdtempSync(path.join(os.tmpdir(), "cmd-"));
vi.mock("electron", () => ({ app: { getPath: () => userData }, BrowserWindow: { getAllWindows: () => [] } }));

const broadcast = vi.fn();
vi.mock("./registry", async (orig) => ({ ...(await orig<typeof import("./registry")>()), broadcastEvent: (...a: unknown[]) => broadcast(...a) }));

const mode = { current: "execute" };
vi.mock("../db/sessions-queries", () => ({
  getCodingSessionById: () => ({ mode: mode.current, cwd: "/ws" }),
  updateCodingSession: (_db: unknown, _id: string, patch: { mode?: string }) => { if (patch.mode) mode.current = patch.mode; },
}));

const { executeEngineCommand, ENGINE_COMMANDS, previewEnginePrompt } = await import("./engine-commands");
const { getEngineHost, hostRoot } = await import("./engine-bridge");

const ctx = { db: {}, workspacePath: "/ws", getWin: () => null } as never;
const run = (line: string, sessionId = "code-1") => executeEngineCommand(ctx, { sessionId, line });

describe("engine commands", () => {
  beforeAll(async () => {
    // Open a session so the goal and export commands have a log to work on.
    await getEngineHost(ctx).rename("code-1", "Test session", "/ws");
  });

  it("lists what the composer can run", () => {
    expect(ENGINE_COMMANDS.map((c) => c.name)).toEqual(["plan", "compact", "goal", "permission", "export"]);
  });

  it("toggles plan mode and reports the mode", async () => {
    expect(await run("/plan")).toMatchObject({ kind: "success", mode: "plan" });
    expect(await run("/plan off")).toMatchObject({ kind: "success", mode: "execute" });
    expect(await run("/plan write a thing")).toMatchObject({ mode: "plan" });
    expect(await run("/plan", "chat-1")).toMatchObject({ kind: "error" });
  });

  it("emits timeline chips around a command and for plan toggles", async () => {
    broadcast.mockClear();
    await run("/plan");
    const types = broadcast.mock.calls.filter((c) => c[0] === "session:event").map((c) => (c[1] as { event: { type: string } }).event.type);
    expect(types).toEqual(["command/run", "plan/mode", "command/done"]);
  });

  it("manages the goal", async () => {
    expect((await run("/goal")).text).toBe("No goal is set.");
    expect((await run("/goal ship the thing")).text).toContain("ship the thing");
    expect((await run("/goal pause")).text).toContain("[paused]");
    expect((await run("/goal resume")).text).toContain("[active]");
    expect((await run("/goal clear")).text).toBe("Goal cleared.");
    expect((await run("/goal pause")).kind).toBe("error");
  });

  it("shows and changes the permission preset", async () => {
    expect((await run("/permission")).text).toContain("Current:");
    expect(await run("/permission nonsense")).toMatchObject({ kind: "error" });
    expect((await run("/permission yolo")).kind).toBe("success");
  });

  it("exports the session log", async () => {
    const res = await run("/export");
    expect(res.kind).toBe("success");
    const file = res.text!.replace("Session log saved to ", "");
    expect(readFileSync(file, "utf8")).toContain("cairn-session/1");
    expect(path.dirname(file)).toBe(path.join(userData, "session-exports"));
    expect(hostRoot()).toContain("sessions-native");
  });

  it("rejects unknown commands", async () => {
    expect(await run("/nope")).toMatchObject({ kind: "error" });
  });

  it("previews the prompt the coding engine sends", async () => {
    const p = await previewEnginePrompt(ctx, "/ws");
    expect(p.error).toBeUndefined();
    expect(p.text.length).toBeGreaterThan(100);
    expect(p.sections.map((s) => s.name)).toContain("coding");
  });
});
