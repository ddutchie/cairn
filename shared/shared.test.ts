/**
 * Tests for shared pure helpers: date formatters, tool-label prettifier, and
 * markdown stripping. Fake timers pin "now" so relative/boundary math is
 * deterministic (mirrors the desktop src/lib/utils.test.ts conventions).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDate,
  formatDateCompact,
  formatRelative,
  getDueDateStatus,
} from "./format/date";
import { prettifyToolLabel } from "./ui/constants";
import { stripMarkdown } from "./notes/text";
import { applyFormat, insertWikilink } from "./notes/format";

const NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelative", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("returns 'just now' under a minute", () => {
    expect(formatRelative(ago(30 * SEC))).toBe("just now");
    expect(formatRelative(ago(59 * SEC))).toBe("just now");
  });

  it("returns minutes, hours, days at each tier", () => {
    expect(formatRelative(ago(1 * MIN))).toBe("1m ago");
    expect(formatRelative(ago(59 * MIN))).toBe("59m ago");
    expect(formatRelative(ago(1 * HOUR))).toBe("1h ago");
    expect(formatRelative(ago(23 * HOUR))).toBe("23h ago");
    expect(formatRelative(ago(1 * DAY))).toBe("1d ago");
    expect(formatRelative(ago(6 * DAY))).toBe("6d ago");
  });

  it("falls back to an absolute date at 7+ days", () => {
    expect(formatRelative(ago(7 * DAY))).toBe(formatDate(ago(7 * DAY)));
  });
});

describe("formatDateCompact", () => {
  it("handles Today / Yesterday / Nd ago", () => {
    expect(formatDateCompact(NOW.toISOString())).toBe("Today");
    expect(formatDateCompact(new Date(NOW.getTime() - 86400000).toISOString())).toBe("Yesterday");
    expect(formatDateCompact(new Date(NOW.getTime() - 3 * 86400000).toISOString())).toBe("3d ago");
  });

  it("returns Invalid date for garbage", () => {
    expect(formatDateCompact("not-a-date")).toBe("Invalid date");
  });
});

describe("getDueDateStatus", () => {
  it("classifies none / overdue / today / upcoming", () => {
    expect(getDueDateStatus(null)).toBe("none");
    expect(getDueDateStatus(new Date(NOW.getTime() - 2 * 86400000).toISOString())).toBe("overdue");
    expect(getDueDateStatus(NOW.toISOString())).toBe("today");
    expect(getDueDateStatus(new Date(NOW.getTime() + 2 * 86400000).toISOString())).toBe("upcoming");
  });
});

describe("prettifyToolLabel", () => {
  it("strips mcp/svc namespace and prettifies the tool part", () => {
    expect(prettifyToolLabel("mcp__BZfTDDlqAOoB__search-designs")).toBe("Search designs");
    expect(prettifyToolLabel("svc__abc123__list_invoices")).toBe("List invoices");
    expect(prettifyToolLabel("mcp__srv1__weird__tool")).toBe("Weird tool");
  });

  it("leaves already-friendly labels untouched (desktop contract)", () => {
    expect(prettifyToolLabel("Canva · Search designs")).toBe("Canva · Search designs");
    expect(prettifyToolLabel("Reading src/index.ts")).toBe("Reading src/index.ts");
  });

  it("leaves bare tool names untouched by default", () => {
    expect(prettifyToolLabel("create_task")).toBe("create_task");
  });

  it("humanises bare snake/kebab names when prettifyBare is set (mobile)", () => {
    expect(prettifyToolLabel("create_task", { prettifyBare: true })).toBe("Create task");
    expect(prettifyToolLabel("ensure_note", { prettifyBare: true })).toBe("Ensure note");
    // Already-friendly labels stay untouched even with the flag.
    expect(prettifyToolLabel("Canva · Search designs", { prettifyBare: true })).toBe("Canva · Search designs");
  });
});

describe("stripMarkdown", () => {
  it("removes common markdown punctuation and collapses whitespace", () => {
    expect(stripMarkdown("# Title\n\n- **bold** and `code`")).toBe("Title bold and code");
  });

  it("returns empty string for empty input", () => {
    expect(stripMarkdown("")).toBe("");
  });
});

describe("applyFormat", () => {
  const sel = (start: number, end: number) => ({ start, end });

  it("wraps a selection in bold and returns the wrapped range", () => {
    const r = applyFormat("hello world", sel(0, 5), "bold")!;
    expect(r.text).toBe("**hello** world");
    expect(r.selection).toEqual({ start: 0, end: 9 });
  });

  it("unwraps an already-bold selection", () => {
    const r = applyFormat("**hello** world", sel(0, 9), "bold")!;
    expect(r.text).toBe("hello world");
    expect(r.selection).toEqual({ start: 0, end: 5 });
  });

  it("inserts a placeholder when nothing is selected", () => {
    const r = applyFormat("", sel(0, 0), "italic")!;
    expect(r.text).toBe("_italic text_");
    // caret selects the placeholder for easy overwrite
    expect(r.selection).toEqual({ start: 1, end: 12 });
  });

  it("toggles a heading prefix on the cursor line", () => {
    const on = applyFormat("Title\nBody", sel(0, 0), "h1")!;
    expect(on.text).toBe("# Title\nBody");
    const off = applyFormat("# Title\nBody", sel(0, 0), "h1")!;
    expect(off.text).toBe("Title\nBody");
  });

  it("switches between heading levels without stacking prefixes", () => {
    const r = applyFormat("# Title", sel(0, 0), "h2")!;
    expect(r.text).toBe("## Title");
  });

  it("numbers an ordered list across multiple selected lines", () => {
    const r = applyFormat("a\nb\nc", sel(0, 5), "ordered")!;
    expect(r.text).toBe("1. a\n2. b\n3. c");
  });

  it("adds task checkboxes and strips them on toggle-off", () => {
    const on = applyFormat("todo", sel(0, 0), "task")!;
    expect(on.text).toBe("- [ ] todo");
    const off = applyFormat("- [ ] todo", sel(0, 0), "task")!;
    expect(off.text).toBe("todo");
  });

  it("wraps a selection in a fenced code block", () => {
    const r = applyFormat("x = 1", sel(0, 5), "codeblock")!;
    expect(r.text).toBe("```\nx = 1\n```");
  });

  it("makes a link from selected text", () => {
    const r = applyFormat("click", sel(0, 5), "link")!;
    expect(r.text).toBe("[click](url)");
  });

  it("returns null for wikilink (handled by the caller)", () => {
    expect(applyFormat("x", sel(0, 1), "wikilink")).toBeNull();
  });

  it("inserts a wikilink at the selection", () => {
    const r = insertWikilink("see  here", sel(4, 4), "My Note");
    expect(r.text).toBe("see [[My Note]] here");
  });
});
