/**
 * Unit tests for the per-note write registries in src/store/ipc.ts.
 *
 * These guards decide whether a db:changed re-hydration should overwrite the
 * in-memory copy of a note:
 *   - own-write guard  → user just wrote, keep optimistic state (skip snapshot)
 *   - AI-write guard   → AI just wrote, take the snapshot (override own-write)
 *
 * Timing is controlled with fake timers so the window/tail boundaries are
 * asserted deterministically. Each test uses a unique note ID so the
 * module-level maps (shared across tests) cannot bleed state between cases.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  markOwnNoteWrite,
  isOwnNoteWrite,
  markAiNoteWriteStarted,
  markAiNoteWriteEnded,
  isAiNoteWrite,
  hasRecentAiNoteWrite,
} from "./ipc";

// Window/tail constants mirrored from ipc.ts (kept private there).
const OWN_NOTE_WRITE_WINDOW_MS = 1500;
const AI_NOTE_WRITE_TAIL_MS = 5000;

// Unique note ID per test to avoid cross-test state in the module-level maps.
let idCounter = 0;
const uid = (label: string) => `${label}-${++idCounter}`;

// The registries are module-level and shared across tests. We cannot reset them
// directly, so we advance the fake clock far forward on each test (rather than
// resetting to a fixed instant). This guarantees any residual entry from a
// previous test is well past its expiry window and cannot bleed into the next.
let clock = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.useFakeTimers();
  // Jump forward a full day each test — far beyond any window/tail.
  clock += 24 * 60 * 60 * 1000;
  vi.setSystemTime(new Date(clock));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("own-write guard", () => {
  it("reports a freshly written note as an own write", () => {
    const note = uid("own");
    markOwnNoteWrite(note);
    expect(isOwnNoteWrite(note)).toBe(true);
  });

  it("returns false for a note that was never written", () => {
    expect(isOwnNoteWrite(uid("never"))).toBe(false);
  });

  it("expires exactly at the window boundary", () => {
    const note = uid("own");
    markOwnNoteWrite(note);
    // Just inside the window — still an own write.
    vi.advanceTimersByTime(OWN_NOTE_WRITE_WINDOW_MS - 1);
    expect(isOwnNoteWrite(note)).toBe(true);
    // At the window boundary — no longer an own write.
    vi.advanceTimersByTime(1);
    expect(isOwnNoteWrite(note)).toBe(false);
  });

  it("prunes expired entries on the next write", () => {
    const stale = uid("stale");
    const fresh = uid("fresh");
    markOwnNoteWrite(stale);
    vi.advanceTimersByTime(OWN_NOTE_WRITE_WINDOW_MS + 10);
    // A subsequent write for a different note triggers a prune of the stale id.
    markOwnNoteWrite(fresh);
    expect(isOwnNoteWrite(stale)).toBe(false);
    expect(isOwnNoteWrite(fresh)).toBe(true);
  });
});

describe("AI-write guard", () => {
  it("reports a note as AI-written while the write is active", () => {
    const note = uid("ai");
    markAiNoteWriteStarted(note);
    expect(isAiNoteWrite(note)).toBe(true);
    expect(hasRecentAiNoteWrite()).toBe(true);
    // End the write so the active-set entry doesn't leak into later tests.
    markAiNoteWriteEnded(note);
  });

  it("keeps an active write flagged indefinitely (no tail expiry while active)", () => {
    const note = uid("ai");
    markAiNoteWriteStarted(note);
    // Far beyond the tail window, but the write never ended — still active.
    vi.advanceTimersByTime(AI_NOTE_WRITE_TAIL_MS * 10);
    expect(isAiNoteWrite(note)).toBe(true);
    expect(hasRecentAiNoteWrite()).toBe(true);
    // Clean up the active flag so it doesn't leak into later tests' global checks.
    markAiNoteWriteEnded(note);
  });

  it("keeps the note flagged within the tail window after the write ends", () => {
    const note = uid("ai");
    markAiNoteWriteStarted(note);
    markAiNoteWriteEnded(note);
    vi.advanceTimersByTime(AI_NOTE_WRITE_TAIL_MS - 1);
    expect(isAiNoteWrite(note)).toBe(true);
    expect(hasRecentAiNoteWrite()).toBe(true);
  });

  it("expires exactly at the tail boundary after the write ends", () => {
    const note = uid("ai");
    markAiNoteWriteStarted(note);
    markAiNoteWriteEnded(note);
    vi.advanceTimersByTime(AI_NOTE_WRITE_TAIL_MS);
    expect(isAiNoteWrite(note)).toBe(false);
    expect(hasRecentAiNoteWrite()).toBe(false);
  });

  it("returns false for a note that was never AI-written", () => {
    expect(isAiNoteWrite(uid("never"))).toBe(false);
  });

  it("hasRecentAiNoteWrite is true if ANY note is recently AI-written", () => {
    const noteA = uid("ai-a");
    const noteB = uid("ai-b");
    markAiNoteWriteStarted(noteA);
    markAiNoteWriteEnded(noteA);
    // noteA's tail has fully expired...
    vi.advanceTimersByTime(AI_NOTE_WRITE_TAIL_MS);
    expect(isAiNoteWrite(noteA)).toBe(false);
    // ...but a fresh write to noteB keeps the global check true.
    markAiNoteWriteStarted(noteB);
    markAiNoteWriteEnded(noteB);
    expect(hasRecentAiNoteWrite()).toBe(true);
  });
});

describe("guard interaction (the bug this fixes)", () => {
  it("a note can be both own-written and AI-written simultaneously", () => {
    const note = uid("both");
    // User typed (own write), then the AI patched the same note.
    markOwnNoteWrite(note);
    markAiNoteWriteStarted(note);
    markAiNoteWriteEnded(note);

    // Both guards report true within their windows. The merge in store/index.ts
    // uses `isOwnNoteWrite && !isAiNoteWrite` — so the AI write wins and the
    // snapshot content is accepted (the open editor sees the AI's change).
    expect(isOwnNoteWrite(note)).toBe(true);
    expect(isAiNoteWrite(note)).toBe(true);
  });
});
