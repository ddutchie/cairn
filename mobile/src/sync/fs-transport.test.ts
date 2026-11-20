/** writeOwnOplog skips rewriting an unchanged oplog file. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ files: new Map<string, string>(), writes: 0, readDirFails: false, unlinkFailsFor: "" }));

vi.mock("react-native-cloud-store", () => ({
  writeFile: async (path: string, text: string) => {
    h.writes++;
    h.files.set(path, text);
  },
  readFile: async (path: string) => h.files.get(path) ?? "",
  readDir: async () => {
    if (h.readDirFails) throw new Error("iCloud unavailable");
    return [...h.files.keys()];
  },
  exist: async (path: string) => h.files.has(path),
  startDownloadingUbiquitousItem: async () => {},
  unlink: async (path: string) => {
    if (h.unlinkFailsFor && path.includes(h.unlinkFailsFor)) throw new Error("unlink failed");
    h.files.delete(path);
  },
  PathUtils: {
    join: (...parts: string[]) => parts.join("/"),
    iCloudRemoveDotExt: (n: string) => n,
  },
}));
// A stand-in digest is enough: the logic under test only compares digests.
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_: string, text: string) => `${text.length}:${text}`,
}));

const { writeOwnOplog, readOwnOplog, removeWorkspaceFromFolder, hasRemovalMarker, listSources } = await import("./fs-transport");

const entry = (id: string) =>
  ({ id, entity: "notes", entity_id: id, op: "put", payload: {}, hlc: "1", origin: "d" }) as never;

beforeEach(() => {
  h.files.clear();
  h.writes = 0;
  h.readDirFails = false;
  h.unlinkFailsFor = "";
});

describe("writeOwnOplog", () => {
  it("writes the first time and skips an identical rewrite", async () => {
    expect(await writeOwnOplog("f", "dev", "ws", [entry("a")])).toBe(true);
    expect(await writeOwnOplog("f", "dev", "ws", [entry("a")])).toBe(false);
    expect(h.writes).toBe(1);
  });

  it("writes again when the oplog changed", async () => {
    await writeOwnOplog("f", "dev2", "ws", [entry("a")]);
    expect(await writeOwnOplog("f", "dev2", "ws", [entry("a"), entry("b")])).toBe(true);
    expect(h.writes).toBe(2);
  });

  it("rewrites unchanged content if the file disappeared from the folder", async () => {
    await writeOwnOplog("f", "dev3", "ws", [entry("a")]);
    h.files.clear();
    expect(await writeOwnOplog("f", "dev3", "ws", [entry("a")])).toBe(true);
  });
});

describe("readOwnOplog", () => {
  it("reads back what this device published, and [] when there is no file", async () => {
    expect(await readOwnOplog("f", "dev4", "ws")).toEqual([]);
    // Valid entries this time: the reader drops anything the oplog guard rejects.
    const own = (id: string, counter: number) =>
      ({ hlc: `000000000001:000${counter}:dev4`, origin: "dev4", entity: "notes", entity_id: id, op: "put", payload: {} }) as never;
    await writeOwnOplog("f", "dev4", "ws", [own("a", 1), own("b", 2)]);
    expect((await readOwnOplog("f", "dev4", "ws")).map((e) => e.entity_id)).toEqual(["a", "b"]);
  });
});

describe("removeWorkspaceFromFolder", () => {
  it("deletes every device's oplog for the workspace, writes a marker, and leaves other workspaces alone", async () => {
    h.files.set("f/oplog-desktop_1-ws-a.ndjson", "x");
    h.files.set("f/oplog-mobile_2-ws-a.ndjson", "x");
    h.files.set("f/oplog-desktop_1-ws-b.ndjson", "x");
    expect(await removeWorkspaceFromFolder("f", "mobile_2", "ws-a")).toBe(2);
    expect([...h.files.keys()].sort()).toEqual(["f/oplog-desktop_1-ws-b.ndjson", "f/removed-ws-a.json"]);
    expect(await hasRemovalMarker("f", "ws-a")).toBe(true);
  });
  it("lets this device publish again afterwards", async () => {
    await writeOwnOplog("f", "mobile_3", "ws-c", [entry("a")]);
    await removeWorkspaceFromFolder("f", "mobile_3", "ws-c");
    expect(await writeOwnOplog("f", "mobile_3", "ws-c", [entry("a")])).toBe(true);
  });
});

describe("removeWorkspaceFromFolder safety", () => {
  it("only deletes oplogs of the exact workspace, not one whose id merely ends with it", async () => {
    h.files.set("f/oplog-desktop_1-ws1.ndjson", "x");
    h.files.set("f/oplog-desktop_1-team-ws1.ndjson", "x");
    expect(await removeWorkspaceFromFolder("f", "mobile_2", "ws1")).toBe(1);
    expect(h.files.has("f/oplog-desktop_1-team-ws1.ndjson")).toBe(true);
    expect(h.files.has("f/oplog-desktop_1-ws1.ndjson")).toBe(false);
  });

  it("removes the marker it added when deleting fails, so the workspace stays visible and retryable", async () => {
    h.files.set("f/oplog-desktop_1-ws1.ndjson", "x");
    h.unlinkFailsFor = "oplog-desktop_1-ws1";
    await expect(removeWorkspaceFromFolder("f", "mobile_2", "ws1")).rejects.toThrow("unlink failed");
    expect(h.files.has("f/removed-ws1.json")).toBe(false);
  });

  it("keeps a marker that was already there (the desktop's) when deleting fails", async () => {
    h.files.set("f/removed-ws1.json", "{}");
    h.files.set("f/oplog-desktop_1-ws1.ndjson", "x");
    h.unlinkFailsFor = "oplog-desktop_1-ws1";
    await expect(removeWorkspaceFromFolder("f", "mobile_2", "ws1")).rejects.toThrow();
    expect(h.files.has("f/removed-ws1.json")).toBe(true);
  });
});

describe("removal markers", () => {
  it("hasRemovalMarker surfaces a folder read failure instead of answering 'no marker'", async () => {
    h.readDirFails = true;
    await expect(hasRemovalMarker("f", "ws-a")).rejects.toThrow("iCloud unavailable");
  });

  it("detects a marker for the workspace only", async () => {
    h.files.set("f/removed-ws-a.json", "{}");
    expect(await hasRemovalMarker("f", "ws-a")).toBe(true);
    expect(await hasRemovalMarker("f", "ws-b")).toBe(false);
  });
  it("listSources skips a workspace the desktop removed", async () => {
    h.files.set("f/oplog-desktop_1-ws-a.ndjson", "");
    h.files.set("f/oplog-desktop_1-ws-b.ndjson", "");
    h.files.set("f/removed-ws-a.json", "{}");
    expect((await listSources("f", "me")).map((s) => s.workspaceId)).toEqual(["ws-b"]);
  });
});
