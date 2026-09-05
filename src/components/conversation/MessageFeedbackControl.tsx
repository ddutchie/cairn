"use client";

/**
 * MessageFeedbackControl — thumbs up/down + note popover for one assistant
 * message bubble. Shared by every pane (both chat and coding render through
 * ConversationMessageBubble): the bubble passes its dsh session id + message
 * id, and this control drives the `session:feedback` / `session:feedback-get`
 * IPC channels onto dsh's message-feedback sidecar.
 *
 * Self-hiding when the target is not ratable (non-finalized message); errors
 * otherwise surface as a tooltip so a failed rating never breaks the bubble.
 */

import React, { useState } from "react";
import { ThumbsUp, ThumbsDown, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageFeedbackControlProps {
  sessionId?: string;
  messageId: string;
  disabled?: boolean;
}

interface FeedbackState {
  rating: "positive" | "negative";
  note?: string;
  version: string;
}

type Envelope<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function MessageFeedbackControl({ sessionId, messageId, disabled }: MessageFeedbackControlProps) {
  const [current, setCurrent] = useState<FeedbackState | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  if (!sessionId || hidden) return null;

  async function rate(rating: "positive" | "negative") {
    if (disabled || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = (await window.electron?.session.feedback({ sessionId: sessionId!, messageId, rating })) as Envelope<FeedbackState> | undefined;
      if (!res) return;
      if (res.ok) {
        setCurrent({ rating: res.value.rating as "positive" | "negative", note: res.value.note, version: res.value.version });
      } else if (res.code === "target-not-found" || res.code === "session-not-found") {
        // Not a finalized ratable message (e.g. transient/derived bubble) —
        // hide the control rather than nagging.
        setHidden(true);
      } else {
        setError(res.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "rating failed");
    } finally {
      setSaving(false);
    }
  }

  async function openNote() {
    if (disabled || saving) return;
    setError(null);
    // Load the stored note (if any) so Save preserves rating + edits text.
    try {
      const res = (await window.electron?.session.feedbackGet(sessionId!, messageId)) as Envelope<FeedbackState | null> | undefined;
      if (res?.ok && res.value) {
        setCurrent({ rating: res.value.rating as "positive" | "negative", note: res.value.note, version: res.value.version });
        setDraftNote(res.value.note ?? "");
      } else if (res && !res.ok && res.code !== "target-not-found" && res.code !== "session-not-found") {
        setError(res.message);
        return;
      } else {
        setDraftNote(current?.note ?? "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load note");
      return;
    }
    setNoteOpen(true);
  }

  async function saveNote() {
    if (saving) return;
    const text = draftNote.trim();
    setSaving(true);
    setError(null);
    try {
      // A note rides on a rating; default to thumbs-up when unrated.
      const res = (await window.electron?.session.feedback({
        sessionId: sessionId!,
        messageId,
        rating: current?.rating ?? "positive",
        ...(text ? { note: draftNote } : {}),
      })) as Envelope<FeedbackState> | undefined;
      if (!res) return;
      if (res.ok) {
        setCurrent({ rating: res.value.rating as "positive" | "negative", note: res.value.note, version: res.value.version });
        setNoteOpen(false);
      } else {
        setError(res.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save note");
    } finally {
      setSaving(false);
    }
  }

  const rated = current !== null;
  const visible = rated || undefined; // active ratings stay visible outside hover

  return (
    <span className={cn("relative flex items-center gap-0.5 transition-opacity", rated ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")} data-visible={visible}>
      <button
        type="button"
        onClick={() => void rate("positive")}
        disabled={disabled || saving}
        title={error ?? "Rate helpful"}
        aria-label="Rate message helpful"
        aria-pressed={current?.rating === "positive"}
        className={cn(
          "p-0.5 rounded transition-colors",
          current?.rating === "positive"
            ? "text-[var(--accent)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]",
        )}
      >
        <ThumbsUp size={10} fill={current?.rating === "positive" ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={() => void rate("negative")}
        disabled={disabled || saving}
        title={error ?? "Rate not helpful"}
        aria-label="Rate message not helpful"
        aria-pressed={current?.rating === "negative"}
        className={cn(
          "p-0.5 rounded transition-colors",
          current?.rating === "negative"
            ? "text-[var(--accent)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]",
        )}
      >
        <ThumbsDown size={10} fill={current?.rating === "negative" ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={() => void (noteOpen ? setNoteOpen(false) : openNote())}
        disabled={disabled || saving}
        title={current?.note ? `Feedback note: ${current.note}` : error ?? "Add a feedback note"}
        aria-label={current?.note ? "Edit feedback note" : "Add a feedback note"}
        aria-expanded={noteOpen}
        className={cn(
          "p-0.5 rounded transition-colors",
          current?.note
            ? "text-[var(--accent)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]",
        )}
      >
        <MessageSquareText size={10} />
      </button>
      {noteOpen && (
        <span className="absolute left-0 bottom-full mb-1 z-20 w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg p-2 flex flex-col gap-1.5">
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="What was good or bad about this reply?"
            rows={3}
            maxLength={8000}
            className="w-full resize-y rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-[0.714rem] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
          />
          {error && <span className="text-[0.643rem] text-[var(--danger)]">{error}</span>}
          <span className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setNoteOpen(false)}
              className="px-2 py-0.5 rounded text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveNote()}
              disabled={saving}
              className="px-2 py-0.5 rounded text-[0.714rem] font-medium bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
