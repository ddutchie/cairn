/**
 * dsh ⇄ Cairn slot comparison matrix + alias layer.
 *
 * dsh's client UI plugins register into named slots (its SlotMap). Cairn has its
 * OWN slot matrix (slot-matrix.ts) mapped to Cairn's real DOM (a notes/board/
 * graph app), NOT dsh's fixed 3-column conversation AppFrame. To let a
 * self-contained dsh UI plugin still work here, we ALIAS the dsh slot names that
 * have a genuine Cairn equivalent onto Cairn slots. Slots tied to dsh's shell
 * layout (conversation.*, details, root, the composer internals) have NO Cairn
 * home without adopting dsh's whole shell (§9/§B) — those are intentionally
 * unmapped, and a dsh plugin targeting them is reported as unsupported.
 *
 * This table is the single source of truth for "what dsh has, what we have, and
 * what's missing" — keep it honest as slots are added on either side.
 */
import type { SlotName } from "./slot-matrix";
import { ALL_SLOTS } from "./slot-matrix";

/** Every production dsh client slot (test-only slots excluded). */
export type DshSlotStatus =
  | { status: "aliased"; to: SlotName; note?: string }        // maps onto a Cairn slot
  | { status: "cairn-has-different"; note: string }           // Cairn covers it a different way (not via this slot)
  | { status: "shell-only"; note: string }                    // needs dsh's AppFrame/session shell — no Cairn home
  | { status: "planned"; note: string };                      // a Cairn slot we intend to add

export const DSH_SLOT_MATRIX: Record<string, { kind: string; scope: string; pkg: string } & DshSlotStatus> = {
  // ── Frame-level (runtime + ui-layout) ─────────────────────────────────────
  "root":            { kind: "single", scope: "root", pkg: "runtime",   status: "shell-only", note: "The whole AppFrame. Cairn owns its own root; a plugin taking root would erase the app." },
  "shell.overlay":   { kind: "list",   scope: "root", pkg: "ui-layout", status: "aliased", to: "app.overlay", note: "Frame-wide click-through floating layer — exact concept match." },
  "sidebar":         { kind: "single", scope: "root", pkg: "ui-layout", status: "cairn-has-different", note: "Cairn has its own <Sidebar/>; a takeover of the whole sidebar isn't offered. See sidebar.footer.action → sidebar.footer." },
  "conversation":    { kind: "single", scope: "session-maybe", pkg: "ui-layout", status: "shell-only", note: "dsh's conversation column. Cairn's chat is UnifiedChatPanel, not a takeover slot." },
  "details":         { kind: "single", scope: "session", pkg: "ui-layout", status: "shell-only", note: "dsh's right details column. No Cairn equivalent region." },

  // ── Sidebar (ui-sidebar) ──────────────────────────────────────────────────
  "sidebar.brand.mark":  { kind: "single", scope: "root", pkg: "ui-sidebar", status: "cairn-has-different", note: "Cairn owns its branding." },
  "sidebar.brand.name":  { kind: "single", scope: "root", pkg: "ui-sidebar", status: "cairn-has-different", note: "Cairn owns its branding." },
  "sidebar.workspaces":  { kind: "single", scope: "root", pkg: "ui-sidebar", status: "cairn-has-different", note: "Cairn's workspace switcher is native." },
  "sidebar.settings":    { kind: "single", scope: "root", pkg: "ui-sidebar", status: "cairn-has-different", note: "Cairn's settings entry is native." },
  "sidebar.footer.action": { kind: "list", scope: "root", pkg: "ui-sidebar", status: "aliased", to: "sidebar.footer", note: "Additive sidebar-bottom actions — live host mounted below the Settings button." },

  // ── Conversation shell (ui-conversation) — mostly shell-only ───────────────
  "conversation.session":                 { kind: "single", scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Session frame inside dsh's conversation column." },
  "conversation.session.header":          { kind: "single", scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Conversation header region." },
  "conversation.session.header.actions":  { kind: "list",   scope: "session", pkg: "ui-conversation", status: "aliased", to: "view.header.actions", note: "Per-view header buttons — live host in Cairn's Topbar." },
  "conversation.session.header.utilities":{ kind: "list",   scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Header utility cluster — dsh-shell specific." },
  "conversation.view":                    { kind: "list",   scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Tabs inside dsh's conversation column." },
  "conversation.chat.node":               { kind: "chain?", scope: "session", pkg: "ui-conversation", status: "cairn-has-different", note: "Per-message node rendering; Cairn renders its own transcript. tool.call.toolview is the supported per-call hook." },
  "conversation.chat.commandview":        { kind: "keyed",  scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Slash-command result views — Cairn has no equivalent yet." },
  "conversation.message.images":          { kind: "single", scope: "session", pkg: "ui-conversation", status: "cairn-has-different", note: "Cairn renders message images natively." },
  "conversation.details.tool":            { kind: "single", scope: "session", pkg: "ui-conversation", status: "cairn-has-different", note: "Cairn's tool.call.toolview covers per-tool UI." },
  "conversation.composer":                { kind: "chain",  scope: "session", pkg: "ui-conversation", status: "shell-only", note: "dsh composer takeover." },
  "conversation.composer.dock":           { kind: "list",   scope: "session", pkg: "ui-conversation", status: "aliased", to: "chat.transcript.footer", note: "Ambient readout under the composer (dsh's stats line lives here) — maps to Cairn's chat footer (host not yet mounted; data is Cairn's usage, not dsh useProjection)." },
  "conversation.composer.bar":            { kind: "single", scope: "session-maybe", pkg: "ui-conversation", status: "shell-only", note: "The composer bar itself." },
  "conversation.hero.workspace":          { kind: "single", scope: "root", pkg: "ui-conversation", status: "shell-only", note: "Empty-state hero." },
  "conversation.hero.brand.mark":         { kind: "single", scope: "root", pkg: "ui-conversation", status: "shell-only", note: "Empty-state hero branding." },
  "conversation.input.dock":              { kind: "list",   scope: "session", pkg: "ui-conversation", status: "planned", note: "Row above the composer (queue/todo/goal). Could map to a Cairn chat.input.dock host later." },
  "conversation.input.left":              { kind: "list",   scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Composer-left affordances." },
  "conversation.input.right":             { kind: "list",   scope: "session", pkg: "ui-conversation", status: "shell-only", note: "Composer-right affordances." },
  "conversation.input.attachments":       { kind: "single", scope: "session", pkg: "ui-conversation", status: "cairn-has-different", note: "Cairn has its own attachment UI." },
  "conversation.input.plan":              { kind: "single", scope: "session", pkg: "ui-conversation", status: "cairn-has-different", note: "Cairn has its own plan-mode UI." },
  "conversation.input.model":             { kind: "single", scope: "session", pkg: "ui-conversation", status: "cairn-has-different", note: "Cairn has its own model picker." },
  "conversation.input.overlay":           { kind: "list",   scope: "session", pkg: "ui-input-trigger", status: "shell-only", note: "Composer-anchored popup (slash menu)." },

  // ── Tool views (ui-tool) — the exact-match case ───────────────────────────
  "tool.call.toolview": { kind: "keyed", scope: "session", pkg: "ui-tool", status: "aliased", to: "tool.call.toolview", note: "SAME NAME. A dsh toolview plugin registers here verbatim (§11 SkillRow proves it)." },

  // ── Settings (ui-settings / ui-settings-plugins) ──────────────────────────
  "settings.trigger":       { kind: "single", scope: "root", pkg: "ui-settings", status: "cairn-has-different", note: "Cairn's settings entry is native." },
  "settings.header":        { kind: "single", scope: "root", pkg: "ui-settings", status: "cairn-has-different", note: "Cairn owns the settings header." },
  "settings.action":        { kind: "list",   scope: "root", pkg: "ui-settings", status: "planned", note: "Header actions in settings; could map to a Cairn settings host." },
  "settings.close":         { kind: "single", scope: "root", pkg: "ui-settings", status: "cairn-has-different", note: "Native." },
  "settings.section":       { kind: "list",   scope: "root", pkg: "ui-settings", status: "aliased", to: "settings.section", note: "SAME NAME — a settings section. Cairn host is a stub for now." },
  "settings.plugins.tab":   { kind: "list",   scope: "root", pkg: "ui-settings", status: "planned", note: "The Plugins tab surface — matches our planned Plugins settings tab." },
  "settings.onboarding":    { kind: "list",   scope: "root", pkg: "ui-settings", status: "cairn-has-different", note: "Cairn has its own onboarding." },
  "settings.general.item":  { kind: "list",   scope: "root", pkg: "ui-settings", status: "planned", note: "General settings items." },
  "settings.plugin.item":   { kind: "keyed",  scope: "root", pkg: "ui-settings-plugins", status: "planned", note: "Per-plugin config card (keyed by settings namespace) — matches our planned per-plugin cards." },
};

/** The alias map the loader applies: dsh slot name → Cairn slot name. */
export const DSH_SLOT_ALIAS: Partial<Record<string, SlotName>> = Object.fromEntries(
  Object.entries(DSH_SLOT_MATRIX)
    .filter(([, v]) => v.status === "aliased")
    .map(([dshName, v]) => [dshName, (v as { to: SlotName }).to]),
);

/** Resolve a slot name a plugin asked for (dsh or Cairn) to a Cairn slot, or null. */
export function resolveSlotName(requested: string): SlotName | null {
  const aliased = DSH_SLOT_ALIAS[requested];
  if (aliased) return aliased;
  // Already a Cairn slot name?
  return (ALL_SLOTS as string[]).includes(requested) ? (requested as SlotName) : null;
}

/** Summary counts for docs / a future Plugins tab. */
export function dshCompatSummary() {
  const by = { aliased: 0, "cairn-has-different": 0, "shell-only": 0, planned: 0 } as Record<string, number>;
  for (const v of Object.values(DSH_SLOT_MATRIX)) by[v.status]++;
  return by;
}
