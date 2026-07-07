import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeOplogFile, readPeerOplogs } from "./transport";
import type { OplogEntry } from "./engine";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cairn-transport-"));
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const entry: OplogEntry = {
  hlc: "0000000003e8:0000:dev_a",
  origin: "dev_a",
  entity: "notes",
  entity_id: "n1",
  op: "put",
  payload: { id: "n1", title: "T" },
};

describe("transport deviceId sanitization", () => {
  it("rejects path separators and traversal in deviceId", () => {
    const dir = tmpDir();
    dirs.push(dir);
    expect(() => writeOplogFile(dir, "../evil", [entry])).toThrow(/Unsafe sync deviceId/);
    expect(() => writeOplogFile(dir, "a/b", [entry])).toThrow(/Unsafe sync deviceId/);
    expect(() => writeOplogFile(dir, "..", [entry])).toThrow(/Unsafe sync deviceId/);
  });

  it("accepts normal device ids", () => {
    const dir = tmpDir();
    dirs.push(dir);
    expect(() => writeOplogFile(dir, "desktop_ab12cd34", [entry])).not.toThrow();
  });
});

describe("transport oplog shape validation", () => {
  it("skips malformed / partial lines but keeps valid entries", () => {
    const dir = tmpDir();
    dirs.push(dir);
    // Hand-write a peer file with a mix of valid, malformed-JSON, and wrong-shape lines.
    const file = path.join(dir, "oplog-dev_b.ndjson");
    fs.writeFileSync(
      file,
      [
        JSON.stringify(entry),
        "{ not json",
        JSON.stringify({ hlc: "x", entity: "notes" }), // missing fields
        JSON.stringify({ ...entry, op: "frobnicate" }), // bad op
        JSON.stringify({ ...entry, entity_id: "n2" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const got = readPeerOplogs(dir, "dev_a");
    expect(got.map((e) => e.entity_id).sort()).toEqual(["n1", "n2"]);
  });
});
