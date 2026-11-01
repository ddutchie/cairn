/** writeOwnOplog skips rewriting an unchanged oplog file. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ files: new Map<string, string>(), writes: 0 }));

vi.mock("react-native-cloud-store", () => ({
  writeFile: async (path: string, text: string) => {
    h.writes++;
    h.files.set(path, text);
  },
  readFile: async (path: string) => h.files.get(path) ?? "",
  readDir: async () => [...h.files.keys()],
  exist: async (path: string) => h.files.has(path),
  startDownloadingUbiquitousItem: async () => {},
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

const { writeOwnOplog } = await import("./fs-transport");

const entry = (id: string) =>
  ({ id, entity: "notes", entity_id: id, op: "put", payload: {}, hlc: "1", origin: "d" }) as never;

beforeEach(() => {
  h.files.clear();
  h.writes = 0;
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
