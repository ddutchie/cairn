/**
 * Mobile writes People rows through the shared queries (`shared/people/queries.ts`,
 * the same code the desktop runs) on a database with the mobile schema, whose
 * capture triggers are generated from SYNCABLE_TABLES. These tests run that
 * device against a desktop-schema device through the real sync engine and the
 * oplog folder, and check what the plan promises: attendee claims merge per
 * source, removals are tombstones that propagate, rows converge on one id, and
 * a no-op doesn't stage anything (no sync churn).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../../electron/db/schema";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "../../mobile/src/db/schema";
import { SyncEngine } from "../sync/engine";
import { readPeerOplogs, writeOplogFile } from "../sync/transport";
import * as pq from "./queries";
import { captureNoteMeeting } from "./capture";
import { ownedItemsIn, setItemDone } from "./action-items";
import { loadCandidates } from "./capture";
import { attendeeRowId } from "./ids";
import { parseClaims } from "./claims";

function mobileDevice(id: string) {
  const db = new BetterSqlite3(":memory:");
  db.exec(MOBILE_SCHEMA_SQL);
  db.exec(MOBILE_TRIGGERS_SQL);
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('device_id', ?)").run(id);
  return { db, engine: new SyncEngine(db, id) };
}

function desktopDevice(id: string) {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return { db, engine: new SyncEngine(db, id) };
}

type Device = { db: Database.Database; engine: SyncEngine };

/** Drain local writes into the oplog and exchange it through the folder, twice (like a sync round). */
function sync(dir: string, ...devices: Device[]) {
  for (let pass = 0; pass < 2; pass++) {
    for (const d of devices) {
      d.engine.drainPending();
      writeOplogFile(dir, d.engine.deviceId, d.engine.exportOplog());
    }
    for (const d of devices) d.engine.applyRemote(readPeerOplogs(dir, d.engine.deviceId));
  }
}

const NOW = "2026-11-18T09:00:00.000Z";

function seed(desktop: Device) {
  const e = desktop.engine;
  e.put("workspaces", { id: "ws1", name: "WS", created_at: NOW, updated_at: NOW });
  e.put("projects", { id: "p1", workspace_id: "ws1", name: "Proj", created_at: NOW, updated_at: NOW });
  e.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Weekly sync", content: "- [ ] **Ana Ruiz** - send the deck\n- [ ] **Team** - plan\n", created_at: NOW, updated_at: NOW, content_text: "" });
  e.put("people", { id: "ana", workspace_id: "ws1", name: "Ana Ruiz", created_at: NOW, updated_at: NOW });
  e.put("people", { id: "me", workspace_id: "ws1", name: "Me", is_me: 1, created_at: NOW, updated_at: NOW });
}

const attendee = (db: Database.Database, meetingId: string, personId: string) =>
  db.prepare("SELECT * FROM meeting_attendees WHERE id = ?").get(attendeeRowId(meetingId, personId)) as
    { deleted_at: string | null; sources: string; source: string; status: string } | undefined;

describe("mobile People writes sync like the desktop's", () => {
  let dir: string;
  let desktop: Device;
  let mobile: Device;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-people-sync-"));
    desktop = desktopDevice("desktop");
    mobile = mobileDevice("mobile");
    seed(desktop);
    sync(dir, desktop, mobile);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an attendee added on mobile reaches the desktop with its claim and a deterministic id", () => {
    const { meetingId } = captureNoteMeeting(mobile.db, { noteId: "n1", attendees: [], source: "manual", provenance: "explicit" });
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", status: "confirmed", source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);

    const row = attendee(desktop.db, meetingId, "ana")!;
    expect(row.deleted_at).toBeNull();
    expect(parseClaims(row.sources).manual.on).toBe(true);
    expect(pq.listAttendees(desktop.db, meetingId).map((a) => a.personId)).toEqual(["ana"]);
    // The note's meeting link came across too.
    expect((desktop.db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get() as { meeting_id: string }).meeting_id).toBe(meetingId);
  });

  it("claims from two devices both survive, and a person stays until the last source lets go", () => {
    const { meetingId } = captureNoteMeeting(mobile.db, { noteId: "n1", attendees: [], source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    // Offline: the desktop's Today run lists Ana (calendar); on the phone the user confirms her (manual).
    pq.addAttendee(desktop.db, { meetingId, personId: "ana", source: "calendar", provenance: "explicit" });
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    for (const d of [desktop, mobile]) {
      const claims = parseClaims(attendee(d.db, meetingId, "ana")!.sources);
      expect([claims.calendar?.on, claims.manual?.on]).toEqual([true, true]);
    }

    // The phone's own claim goes (its user un-confirms her); the calendar still lists her.
    expect(pq.removeAttendeeSource(mobile.db, meetingId, "ana", "manual")).toBe(false);
    sync(dir, desktop, mobile);
    for (const d of [desktop, mobile]) {
      const row = attendee(d.db, meetingId, "ana")!;
      expect(row.deleted_at).toBeNull();
      expect(parseClaims(row.sources).manual.on).toBe(false);
      expect(parseClaims(row.sources).calendar.on).toBe(true);
    }
  });

  it("removing an attendee on mobile is a tombstone that reaches the desktop", () => {
    const { meetingId } = captureNoteMeeting(mobile.db, { noteId: "n1", attendees: [], source: "manual", provenance: "explicit" });
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    pq.removeAttendee(mobile.db, meetingId, "ana");
    sync(dir, desktop, mobile);
    expect(attendee(desktop.db, meetingId, "ana")!.deleted_at).not.toBeNull();
    expect(pq.listAttendees(desktop.db, meetingId)).toEqual([]);
    // Adding her again revives the same row (same id), on both devices.
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    expect(attendee(desktop.db, meetingId, "ana")!.deleted_at).toBeNull();
    expect(desktop.db.prepare("SELECT COUNT(*) AS n FROM meeting_attendees").get()).toEqual({ n: 1 });
  });

  it("the same attendee added on both devices at once is one row", () => {
    const { meetingId } = captureNoteMeeting(mobile.db, { noteId: "n1", attendees: [], source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    pq.addAttendee(desktop.db, { meetingId, personId: "ana", source: "manual", provenance: "explicit" });
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    for (const d of [desktop, mobile]) {
      expect(d.db.prepare("SELECT COUNT(*) AS n FROM meeting_attendees WHERE person_id = 'ana'").get()).toEqual({ n: 1 });
      // One row, and it is live (not a tombstone on each side).
      expect(pq.listAttendees(d.db, meetingId).map((a) => a.personId)).toEqual(["ana"]);
    }
  });

  it("repeating a write that changes nothing stages nothing (no sync churn)", () => {
    const { meetingId } = captureNoteMeeting(mobile.db, { noteId: "n1", attendees: [], source: "manual", provenance: "explicit" });
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", source: "manual", provenance: "explicit" });
    sync(dir, desktop, mobile);
    expect(mobile.db.prepare("SELECT COUNT(*) AS n FROM sync_pending").get()).toEqual({ n: 0 });

    // Confirming someone who is already confirmed by the same source, reading, and a settled sync round.
    pq.addAttendee(mobile.db, { meetingId, personId: "ana", status: "confirmed", source: "manual", provenance: "explicit" });
    pq.listAttendees(mobile.db, meetingId);
    expect(mobile.db.prepare("SELECT COUNT(*) AS n FROM sync_pending").get()).toEqual({ n: 0 });
    const before = mobile.engine.exportOplog().length;
    sync(dir, desktop, mobile);
    expect(mobile.engine.exportOplog().length).toBe(before);
    expect(desktop.engine.exportOplog().length).toBe(before);
  });

  it("a person's relationship and cadence edit syncs, and the persona/open-item reads agree on both devices", () => {
    pq.updatePerson(mobile.db, "ana", { relationship: [{ type: "direct_report", provenance: "explicit" }], cadence: "weekly" });
    sync(dir, desktop, mobile);
    const onDesktop = pq.getPerson(desktop.db, "ana")!;
    expect(onDesktop.cadence).toBe("weekly");
    expect(onDesktop.relationship.map((r) => r.type)).toEqual(["direct_report"]);

    // Open items come from the same parser on both sides; the team line stays unowned.
    for (const d of [desktop, mobile]) {
      const content = (d.db.prepare("SELECT content FROM notes WHERE id = 'n1'").get() as { content: string }).content;
      const items = ownedItemsIn(content, loadCandidates(d.db, "ws1"));
      expect(items.map((i) => [i.ownerText, i.ownerPersonId])).toEqual([["Ana Ruiz", "ana"], ["Team", null]]);
    }
  });

  it("ticking an item on mobile rewrites only that box in the note and reaches the desktop", () => {
    const content = (mobile.db.prepare("SELECT content FROM notes WHERE id = 'n1'").get() as { content: string }).content;
    const [ana] = ownedItemsIn(content, loadCandidates(mobile.db, "ws1"));
    const ticked = setItemDone(content, ana.lineKey, true)!;
    expect(ticked).toBe("- [x] **Ana Ruiz** - send the deck\n- [ ] **Team** - plan\n");
    mobile.db.prepare("UPDATE notes SET content = ?, updated_at = ?, version = version + 1 WHERE id = 'n1'").run(ticked, "2026-11-18T10:00:00.000Z");
    sync(dir, desktop, mobile);
    expect((desktop.db.prepare("SELECT content FROM notes WHERE id = 'n1'").get() as { content: string }).content).toBe(ticked);
    // The key survives the tick, so the desktop's index (and a later untick) still finds the line.
    expect(ownedItemsIn(ticked, loadCandidates(desktop.db, "ws1"))[0].lineKey).toBe(ana.lineKey);
  });
});
