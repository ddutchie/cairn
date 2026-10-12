/**
 * Attachment (image) sync between two desktops sharing one sync folder:
 * manifest registration → blob publish → peer fetch, plus the safety cases
 * (name collision never overwrites, tampered blob never installs, unsafe
 * manifest names never touch the filesystem).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { applySchema } from "../db/schema";
import * as q from "../db/queries";
import { setSyncFolder, syncDesktop, setAttachmentWorkspaceProvider, resetDesktopEngine } from "./desktop-sync";
import { blobsDirName } from "../../shared/sync/attachments";

const PNG_A = Buffer.from("89504e470d0a1a0a-image-A", "utf-8");
const PNG_B = Buffer.from("89504e470d0a1a0a-image-B-different", "utf-8");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Device {
  db: Database.Database;
  ws: string;
}

describe("attachment sync", () => {
  let root: string;
  let folder: string;
  let a: Device;
  let b: Device;

  const tick = async (d: Device) => {
    resetDesktopEngine();
    setAttachmentWorkspaceProvider(() => d.ws);
    return syncDesktop(d.db);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-att-test-"));
    folder = path.join(root, "sync");
    fs.mkdirSync(folder);
    const mk = (name: string): Device => {
      const ws = path.join(root, name);
      fs.mkdirSync(path.join(ws, "attachments"), { recursive: true });
      const db = new BetterSqlite3(":memory:");
      applySchema(db);
      setSyncFolder(db, folder);
      return { db, ws };
    };
    a = mk("a");
    b = mk("b");
    q.createWorkspace(a.db, { id: "ws1", name: "WS" });
    q.createProject(a.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(a.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Pics", content: "hello ![[pic.png]] and ![[pic.png|300]]" });
    fs.writeFileSync(path.join(a.ws, "attachments", "pic.png"), PNG_A);
  });

  afterEach(() => {
    a.db.close();
    b.db.close();
    setAttachmentWorkspaceProvider(null);
    resetDesktopEngine();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers, publishes and fetches an embedded image on the peer", async () => {
    const ra = await tick(a);
    expect(ra.attachments).toMatchObject({ registered: 1, published: 1 });
    expect(fs.existsSync(path.join(folder, blobsDirName("ws1"), `${sha(PNG_A)}.png`))).toBe(true);

    const rb = await tick(b);
    expect(rb.attachments?.fetched).toBe(1);
    expect(fs.readFileSync(path.join(b.ws, "attachments", "pic.png"))).toEqual(PNG_A);
  });

  it("is idempotent — a second tick moves nothing", async () => {
    await tick(a);
    await tick(b);
    const ra = await tick(a);
    const rb = await tick(b);
    expect(ra.attachments).toMatchObject({ registered: 0, published: 0, fetched: 0 });
    expect(rb.attachments).toMatchObject({ registered: 0, published: 0, fetched: 0 });
  });

  it("does not register an embed whose file is missing locally", async () => {
    fs.rmSync(path.join(a.ws, "attachments", "pic.png"));
    const ra = await tick(a);
    expect(ra.attachments?.registered).toBe(0);
  });

  it("keeps both files when the name is taken by different bytes", async () => {
    await tick(a);
    fs.writeFileSync(path.join(b.ws, "attachments", "pic.png"), PNG_B);
    const rb = await tick(b);
    expect(rb.attachments?.collisions).toBe(1);
    expect(fs.readFileSync(path.join(b.ws, "attachments", "pic.png"))).toEqual(PNG_B); // untouched
    expect(fs.readFileSync(path.join(b.ws, "attachments", `pic-${sha(PNG_A).slice(0, 8)}.png`))).toEqual(PNG_A);
    // and it does not keep re-copying every tick
    const again = await tick(b);
    expect(again.attachments?.fetched).toBe(0);
  });

  it("treats a same-size, different-content local file as a collision, not as equal", async () => {
    await tick(a);
    const sameSize = Buffer.from("X".repeat(PNG_A.length));
    expect(sameSize.length).toBe(PNG_A.length);
    fs.writeFileSync(path.join(b.ws, "attachments", "pic.png"), sameSize);
    const rb = await tick(b);
    expect(rb.attachments?.collisions).toBe(1);
    expect(fs.readFileSync(path.join(b.ws, "attachments", "pic.png"))).toEqual(sameSize); // untouched
    expect(fs.readFileSync(path.join(b.ws, "attachments", `pic-${sha(PNG_A).slice(0, 8)}.png`))).toEqual(PNG_A);
  });

  it("leaves no temp files behind in the sync folder", async () => {
    await tick(a);
    const left = fs.readdirSync(path.join(folder, blobsDirName("ws1"))).filter((f) => f.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  it("refuses a blob whose bytes don't match the manifest hash", async () => {
    await tick(a);
    fs.writeFileSync(path.join(folder, blobsDirName("ws1"), `${sha(PNG_A)}.png`), Buffer.from("truncated"));
    const rb = await tick(b);
    expect(rb.attachments?.fetched).toBe(0);
    expect(rb.attachments?.pending).toBe(1);
    expect(fs.existsSync(path.join(b.ws, "attachments", "pic.png"))).toBe(false);
  });

  it("ignores manifest rows with path-traversal names", async () => {
    await tick(a);
    a.db
      .prepare(
        `INSERT INTO attachments (id, workspace_id, hash, name, ext, size, created_at, updated_at)
         VALUES (?, 'ws1', ?, '../evil.png', 'png', 4, 'x', 'x')`,
      )
      .run(`${sha(PNG_B)}:../evil.png`, sha(PNG_B));
    await tick(a);
    await tick(b);
    expect(fs.existsSync(path.join(b.ws, "evil.png"))).toBe(false);
    expect(fs.existsSync(path.join(b.ws, "attachments", "evil.png"))).toBe(false);
  });
});
