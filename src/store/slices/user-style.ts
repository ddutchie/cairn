/**
 * User writing style slice.
 *
 * Persona + full style guide + condensed cheat sheet (single-row `user_style`
 * table). Loaded on demand from Settings → Writing Style; written via the
 * guided wizard. Also read by the get_user_writing_style tool in the main
 * process (chat + agent) — the store is just the Settings UI surface.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { UserStyleRow, UserStyleSaveInput } from "@/types";
import { userStyleClient } from "@/lib/ipc/userstyle";
import { hasElectron } from "@/lib/ipc/client";

export interface UserStyleSlice {
  userStyle: UserStyleRow | null;
  fetchUserStyle: () => Promise<void>;
  saveUserStyle: (input: UserStyleSaveInput) => Promise<UserStyleRow | null>;
  clearUserStyle: () => Promise<void>;
}

export const createUserStyleSlice: StateCreator<CairnStore, [], [], UserStyleSlice> = (set, get) => ({
  userStyle: null,

  async fetchUserStyle() {
    if (typeof window === "undefined" || !hasElectron()) return;
    const style = await userStyleClient.getUserStyle();
    set({ userStyle: style });
  },

  async saveUserStyle(input) {
    if (typeof window === "undefined" || !hasElectron()) return get().userStyle;
    const saved = await userStyleClient.saveUserStyle(input);
    set({ userStyle: saved });
    return saved;
  },

  async clearUserStyle() {
    if (typeof window !== "undefined" && hasElectron()) {
      await userStyleClient.clearUserStyle();
    }
    set({ userStyle: null });
  },
});
