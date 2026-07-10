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

  it("rejects unsafe workspace ids but allows nanoid dashes", () => {
    const dir = tmpDir();
    dirs.push(dir);
    expect(() => writeOplogFile(dir, "dev_a", [entry], "a/b")).toThrow(/Unsafe sync workspaceId/);
    expect(() => writeOplogFile(dir, "dev_a", [entry], "..")).toThrow(/Unsafe sync workspaceId/);
    // Workspace ids are nanoids whose alphabet includes "-", so these are valid.
    expect(() => writeOplogFile(dir, "dev_a", [entry], "Ab-3_xZ9")).not.toThrow();
  });
});

describe("transport workspace-scoped source isolation", () => {
  it("reads only oplogs for the given workspace, excluding self", () => {
    const dir = tmpDir();
    dirs.push(dir);
    // Two workspaces sharing one folder, plus this device's own file.
    writeOplogFile(dir, "pc", [{ ...entry, entity_id: "pcRow" }], "wsWork");
    writeOplogFile(dir, "mobile", [{ ...entry, entity_id: "mobileWork" }], "wsWork");
    writeOplogFile(dir, "mac", [{ ...entry, entity_id: "macRow" }], "wsPersonal");

    // The PC reading its own workspace sees mobile's writeback but NOT the other
    // workspace's file, and not its own.
    const pcView = readPeerOplogs(dir, "pc", "wsWork");
    expect(pcView.map((e) => e.entity_id).sort()).toEqual(["mobileWork"]);

    // A reader on the personal workspace never sees any work-workspace rows.
    const personalView = readPeerOplogs(dir, "phone", "wsPersonal");
    expect(personalView.map((e) => e.entity_id).sort()).toEqual(["macRow"]);
  });

  it("isolates correctly when the workspace id contains a dash", () => {
    const dir = tmpDir();
    dirs.push(dir);
    writeOplogFile(dir, "pc", [{ ...entry, entity_id: "aRow" }], "ws-A_1");
    writeOplogFile(dir, "pc", [{ ...entry, entity_id: "bRow" }], "ws-B_2");
    // Suffix match on the full workspace id must not confuse ws-A_1 with ws-B_2.
    expect(readPeerOplogs(dir, "mobile", "ws-A_1").map((e) => e.entity_id)).toEqual(["aRow"]);
    expect(readPeerOplogs(dir, "mobile", "ws-B_2").map((e) => e.entity_id)).toEqual(["bRow"]);
  });

  it("writes the workspace suffix into the filename", () => {
    const dir = tmpDir();
    dirs.push(dir);
    writeOplogFile(dir, "pc", [entry], "wsWork");
    expect(fs.existsSync(path.join(dir, "oplog-pc-wsWork.ndjson"))).toBe(true);
  });

  it("legacy unsuffixed reads still see all oplog files", () => {
    const dir = tmpDir();
    dirs.push(dir);
    writeOplogFile(dir, "dev_b", [entry]);
    const got = readPeerOplogs(dir, "dev_a");
    expect(got.map((e) => e.entity_id)).toEqual(["n1"]);
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
