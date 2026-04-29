/**
 * Tags slice.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Tag, ID } from "@/types";
import { id } from "@/lib/utils";

function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electron;
}

function ipc(
  fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined
): void {
  if (!isElectron() || !window.electron) return;
  fn(window.electron)?.catch?.((err: unknown) => {
    console.error("[cairn:ipc]", err);
  });
}

// ── Slice interface ───────────────────────────────────────────────────────────

export interface TagsSlice {
  tags: Tag[];

  createTag: (workspaceId: ID, name: string, color?: string) => Tag;
  updateTag: (id: ID, patch: Partial<Pick<Tag, "name" | "color">>) => void;
  deleteTag: (id: ID) => void;
  getTagById: (id: ID) => Tag | undefined;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createTagsSlice: StateCreator<CairnStore, [], [], TagsSlice> = (
  set,
  get
) => ({
  tags: [],

  createTag(workspaceId, name, color = "#6366f1") {
    const tag: Tag = { id: id(), workspaceId, name, color };
    set((s) => ({ tags: [...s.tags, tag] }));
    get().persist();
    ipc((e) => e.tag.create(tag));
    return tag;
  },

  updateTag(tagId, patch) {
    set((s) => ({
      tags: s.tags.map((t) => (t.id === tagId ? { ...t, ...patch } : t)),
    }));
    get().persist();
    ipc(
      (e) =>
        (
          e.tag as { update: (id: string, patch: unknown) => Promise<unknown> }
        ).update(tagId, patch)
    );
  },

  deleteTag(tagId) {
    set((s) => ({
      tags: s.tags.filter((t) => t.id !== tagId),
      notes: s.notes.map((n) =>
        n.tagIds.includes(tagId)
          ? { ...n, tagIds: n.tagIds.filter((tid) => tid !== tagId) }
          : n
      ),
      cards: s.cards.map((c) =>
        c.tagIds.includes(tagId)
          ? { ...c, tagIds: c.tagIds.filter((tid) => tid !== tagId) }
          : c
      ),
    }));
    get().persist();
    ipc(
      (e) =>
        (e.tag as { delete: (id: string) => Promise<unknown> }).delete(tagId)
    );
  },

  getTagById(tagId) {
    return get().tags.find((t) => t.id === tagId);
  },
});
